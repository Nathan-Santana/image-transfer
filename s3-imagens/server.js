const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  DynamoDBClient,
  DescribeTableCommand,
  CreateTableCommand,
} = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");

// ---------------------------------------------------------------------------
// Configuração (LocalStack)
// ---------------------------------------------------------------------------
const ENDPOINT = process.env.AWS_ENDPOINT || "http://localhost:4566";
const BUCKET = process.env.S3_BUCKET || "imagens";
const BUCKET_PROCESSADO = process.env.S3_BUCKET_PROCESSADO || "imagens-processadas"; // preenchido pela Lambda
const TABELA_USUARIOS = process.env.DYNAMO_TABLE || "usuarios";
const PORT = process.env.PORT || 3000;

const awsConfig = {
  endpoint: ENDPOINT,
  region: process.env.AWS_DEFAULT_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
  },
};

const s3 = new S3Client({ ...awsConfig, forcePathStyle: true }); // path style é necessário no LocalStack
const dynamo = new DynamoDBClient(awsConfig);
const db = DynamoDBDocumentClient.from(dynamo); // permite usar objetos JS comuns

const FORMATOS = ["image/jpeg", "image/png", "image/gif", "image/bmp", "image/tiff"];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  // apenas formatos que a Lambda (Jimp) consegue processar
  fileFilter: (req, file, cb) => cb(null, FORMATOS.includes(file.mimetype)),
});

// ---------------------------------------------------------------------------
// Infraestrutura: bucket S3 e tabela DynamoDB
// ---------------------------------------------------------------------------
async function garantirBucket(nome) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: nome }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: nome }));
    console.log(`Bucket "${nome}" criado.`);
  }
}

async function garantirTabela() {
  try {
    await dynamo.send(new DescribeTableCommand({ TableName: TABELA_USUARIOS }));
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
    await dynamo.send(
      new CreateTableCommand({
        TableName: TABELA_USUARIOS,
        KeySchema: [{ AttributeName: "email", KeyType: "HASH" }], // e-mail é a chave primária
        AttributeDefinitions: [{ AttributeName: "email", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      })
    );
    console.log(`Tabela "${TABELA_USUARIOS}" criada.`);
  }
}

// ---------------------------------------------------------------------------
// Senhas (scrypt com salt — a senha nunca é salva em texto puro)
// ---------------------------------------------------------------------------
function gerarHash(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(senha, salt, 64).toString("hex");
  return { salt, hash };
}

function senhaConfere(senha, salt, hashSalvo) {
  const hash = crypto.scryptSync(senha, salt, 64);
  const salvo = Buffer.from(hashSalvo, "hex");
  return salvo.length === hash.length && crypto.timingSafeEqual(hash, salvo);
}

// ---------------------------------------------------------------------------
// Sessões (token aleatório em cookie httpOnly; mantidas em memória)
// ---------------------------------------------------------------------------
const sessoes = new Map(); // token -> email
const COOKIE = "sessao";

function lerCookie(req, nome) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").filter(Boolean).map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k, decodeURIComponent(v.join("="))];
    })
  );
  return cookies[nome];
}

function criarSessao(res, email) {
  const token = crypto.randomBytes(32).toString("hex");
  sessoes.set(token, email);
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
}

async function buscarUsuario(email) {
  const out = await db.send(new GetCommand({ TableName: TABELA_USUARIOS, Key: { email } }));
  return out.Item;
}

// Middleware: só deixa passar quem está logado
async function exigirLogin(req, res, next) {
  const email = sessoes.get(lerCookie(req, COOKIE));
  if (!email) return res.status(401).json({ erro: "Faça login para continuar." });
  try {
    const usuario = await buscarUsuario(email); // dados sempre vêm do DynamoDB
    if (!usuario) return res.status(401).json({ erro: "Usuário não encontrado." });
    req.usuario = usuario;
    next();
  } catch (err) {
    next(err);
  }
}

const normalizarEmail = (e) => String(e || "").trim().toLowerCase();

// ---------------------------------------------------------------------------
// API de autenticação
// ---------------------------------------------------------------------------

// Criar conta
app.post("/api/cadastro", async (req, res) => {
  const nome = String(req.body.nome || "").trim();
  const email = normalizarEmail(req.body.email);
  const senha = String(req.body.senha || "");

  if (!nome || !email || !senha) return res.status(400).json({ erro: "Preencha nome, e-mail e senha." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ erro: "E-mail inválido." });
  if (senha.length < 6) return res.status(400).json({ erro: "A senha deve ter pelo menos 6 caracteres." });

  const { salt, hash } = gerarHash(senha);
  try {
    await db.send(
      new PutCommand({
        TableName: TABELA_USUARIOS,
        Item: { email, nome, senhaHash: hash, salt, criadoEm: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(email)", // impede e-mail duplicado
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException")
      return res.status(409).json({ erro: "Já existe uma conta com esse e-mail." });
    console.error(err);
    return res.status(500).json({ erro: "Falha ao criar conta." });
  }

  criarSessao(res, email); // já entra logado após o cadastro
  res.status(201).json({ nome, email });
});

// Login: busca o usuário no DynamoDB e confere a senha
app.post("/api/login", async (req, res) => {
  const email = normalizarEmail(req.body.email);
  const senha = String(req.body.senha || "");
  try {
    const usuario = await buscarUsuario(email);
    if (!usuario || !senhaConfere(senha, usuario.salt, usuario.senhaHash))
      return res.status(401).json({ erro: "E-mail ou senha incorretos." });
    criarSessao(res, email);
    res.json({ nome: usuario.nome, email: usuario.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Falha no login." });
  }
});

app.post("/api/logout", (req, res) => {
  sessoes.delete(lerCookie(req, COOKIE));
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// Usuário logado
app.get("/api/eu", exigirLogin, (req, res) => {
  const { nome, email, criadoEm } = req.usuario;
  res.json({ nome, email, criadoEm });
});

// ---------------------------------------------------------------------------
// API de imagens (S3) — exige login
// ---------------------------------------------------------------------------
const nomeOriginal = (chave) => chave.split("_").slice(1).join("_") || chave;

app.get("/api/imagens", exigirLogin, async (req, res) => {
  try {
    const [out, outProc] = await Promise.all([
      s3.send(new ListObjectsV2Command({ Bucket: BUCKET })),
      s3.send(new ListObjectsV2Command({ Bucket: BUCKET_PROCESSADO })),
    ]);
    // chave -> tamanho da versão processada pela Lambda
    const processadas = new Map((outProc.Contents || []).map((o) => [o.Key, o.Size]));
    const imagens = (out.Contents || [])
      .sort((a, b) => b.LastModified - a.LastModified)
      .map((o) => ({
        chave: o.Key,
        nome: nomeOriginal(o.Key),
        tamanho: o.Size,
        data: o.LastModified,
        processada: processadas.has(o.Key),
        tamanhoProcessada: processadas.get(o.Key) ?? null,
      }));
    res.json(imagens);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Falha ao listar imagens" });
  }
});

app.post("/api/upload", exigirLogin, upload.single("imagem"), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: "Envie uma imagem JPG, PNG, GIF, BMP ou TIFF." });
  const chave = `${crypto.randomBytes(4).toString("hex")}_${req.file.originalname}`;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: chave,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        Metadata: { enviadopor: req.usuario.email },
      })
    );
    res.json({ ok: true, chave });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Falha no upload" });
  }
});

async function enviarObjeto(req, res, bucket, comoDownload) {
  const chave = req.params[0];
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: chave }));
    res.setHeader("Content-Type", obj.ContentType || "application/octet-stream");
    if (comoDownload) {
      let nome = nomeOriginal(chave);
      if (bucket === BUCKET_PROCESSADO) {
        // ex.: foto.jpg -> foto_processada.jpg (extensão de acordo com o formato gerado)
        const ext = (obj.ContentType || "image/png").split("/")[1].replace("jpeg", "jpg");
        nome = nome.replace(/\.[^.]+$/, "") + "_processada." + ext;
      }
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(nome)}`);
    }
    obj.Body.pipe(res);
  } catch {
    res.status(404).send("Imagem não encontrada");
  }
}

app.get("/ver/*", exigirLogin, (req, res) => enviarObjeto(req, res, BUCKET, false));
app.get("/download/*", exigirLogin, (req, res) => enviarObjeto(req, res, BUCKET, true));
app.get("/ver-processada/*", exigirLogin, (req, res) => enviarObjeto(req, res, BUCKET_PROCESSADO, false));
app.get("/download-processada/*", exigirLogin, (req, res) => enviarObjeto(req, res, BUCKET_PROCESSADO, true));

app.delete("/api/imagens/*", exigirLogin, async (req, res) => {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: req.params[0] }));
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_PROCESSADO, Key: req.params[0] }));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Falha ao excluir" });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ erro: "Arquivo muito grande (máx. 10 MB)." });
  console.error(err);
  res.status(500).json({ erro: "Erro interno" });
});

// ---------------------------------------------------------------------------
// Inicialização (espera o LocalStack ficar pronto)
// ---------------------------------------------------------------------------
async function iniciar(tentativas = 15) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      await garantirBucket(BUCKET);
      await garantirBucket(BUCKET_PROCESSADO);
      await garantirTabela();
      break;
    } catch {
      console.log(`Aguardando LocalStack em ${ENDPOINT}... (${i}/${tentativas})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  app.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
}

iniciar();
