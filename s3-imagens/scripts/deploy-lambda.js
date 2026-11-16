/**
 * Implanta a Lambda "processar-imagem" no LocalStack e liga o gatilho do S3.
 *
 *   1. cria os buckets "imagens" e "imagens-processadas" (se não existirem)
 *   2. compacta a pasta lambda/ (com node_modules) em um .zip
 *   3. cria a função (ou atualiza o código, se já existir)
 *   4. dá permissão para o S3 invocar a função
 *   5. configura a notificação s3:ObjectCreated:* do bucket "imagens" -> Lambda
 *
 * Uso: npm run deploy-lambda   (antes: cd lambda && npm install)
 */
const path = require("path");
const fs = require("fs");
const AdmZip = require("adm-zip");
const {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketNotificationConfigurationCommand,
} = require("@aws-sdk/client-s3");
const {
  LambdaClient,
  GetFunctionCommand,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  AddPermissionCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
} = require("@aws-sdk/client-lambda");

const ENDPOINT = process.env.AWS_ENDPOINT || "http://localhost:4566";
const BUCKET_ORIGEM = process.env.S3_BUCKET || "imagens";
const BUCKET_DESTINO = process.env.S3_BUCKET_PROCESSADO || "imagens-processadas";
const FUNCAO = "processar-imagem";
const REGIAO = process.env.AWS_DEFAULT_REGION || "us-east-1";

const config = {
  endpoint: ENDPOINT,
  region: REGIAO,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};
const s3 = new S3Client({ ...config, forcePathStyle: true });
const lambda = new LambdaClient(config);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function aguardarLocalStack(tentativas = 30) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: "__ping__" }));
      return;
    } catch (err) {
      // 404/403 significa que o S3 respondeu — LocalStack está no ar
      if (err.$metadata?.httpStatusCode) return;
      console.log(`Aguardando LocalStack em ${ENDPOINT}... (${i}/${tentativas})`);
      await esperar(2000);
    }
  }
  throw new Error("LocalStack não respondeu.");
}

async function garantirBucket(nome) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: nome }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: nome }));
    console.log(`Bucket "${nome}" criado.`);
  }
}

function gerarZip() {
  const pasta = path.join(__dirname, "..", "lambda");
  if (!fs.existsSync(path.join(pasta, "node_modules"))) {
    throw new Error('Dependências da Lambda não instaladas. Rode: cd lambda && npm install');
  }
  const zip = new AdmZip();
  zip.addLocalFolder(pasta);
  return zip.toBuffer();
}

async function implantarFuncao(zip) {
  let existe = true;
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: FUNCAO }));
  } catch {
    existe = false;
  }

  if (existe) {
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: FUNCAO, ZipFile: zip }));
    console.log(`Código da função "${FUNCAO}" atualizado.`);
    await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: FUNCAO });
  } else {
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: FUNCAO,
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        Role: "arn:aws:iam::000000000000:role/lambda-role", // LocalStack não valida o papel
        Code: { ZipFile: zip },
        Timeout: 60,
        MemorySize: 512,
        Environment: { Variables: { BUCKET_DESTINO, LARGURA_MAX: "300" } },
      })
    );
    console.log(`Função "${FUNCAO}" criada. Aguardando ficar ativa...`);
    await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 180 }, { FunctionName: FUNCAO });
  }

  const { Configuration } = await lambda.send(new GetFunctionCommand({ FunctionName: FUNCAO }));
  return Configuration.FunctionArn;
}

async function permitirS3(arnFuncao) {
  try {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: arnFuncao,
        StatementId: "s3-invoke",
        Action: "lambda:InvokeFunction",
        Principal: "s3.amazonaws.com",
        SourceArn: `arn:aws:s3:::${BUCKET_ORIGEM}`,
      })
    );
  } catch (err) {
    if (err.name !== "ResourceConflictException") throw err; // já existe
  }
}

async function ligarGatilho(arnFuncao) {
  await s3.send(
    new PutBucketNotificationConfigurationCommand({
      Bucket: BUCKET_ORIGEM,
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          { LambdaFunctionArn: arnFuncao, Events: ["s3:ObjectCreated:*"] },
        ],
      },
    })
  );
  console.log(`Gatilho configurado: s3://${BUCKET_ORIGEM} (ObjectCreated) -> ${FUNCAO}`);
}

(async () => {
  try {
    await aguardarLocalStack();
    await garantirBucket(BUCKET_ORIGEM);
    await garantirBucket(BUCKET_DESTINO);
    const arn = await implantarFuncao(gerarZip());
    await permitirS3(arn);
    await ligarGatilho(arn);
    console.log("Lambda implantada com sucesso.");
  } catch (err) {
    console.error("Falha ao implantar a Lambda:", err.message);
    process.exit(1);
  }
})();
