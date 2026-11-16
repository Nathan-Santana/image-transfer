# Imagens no S3 + contas no DynamoDB + processamento com Lambda (LocalStack)

Aplicação web de uma página (Node.js + Express + AWS SDK v3):

- **S3**: upload, listagem, download e exclusão de imagens no bucket `imagens`.
- **DynamoDB**: cadastro de contas e login. Os usuários ficam na tabela `usuarios`.
- **Lambda**: a função `processar-imagem` é acionada a cada upload no bucket `imagens`. Ela gera uma miniatura em escala de cinza (máx. 300 px de largura) e grava o resultado no bucket `imagens-processadas`.

```
 navegador ──upload──▶ app (Express) ──PutObject──▶ S3 "imagens"
                                                       │ evento s3:ObjectCreated:*
                                                       ▼
                                              Lambda "processar-imagem"
                                              (redimensiona + escala de cinza)
                                                       │ PutObject
                                                       ▼
                                              S3 "imagens-processadas"
```

## Opção 1 — tudo com Docker (recomendado)

```bash
docker compose up
```

Abra http://localhost:3000

O container do app instala as dependências, implanta a Lambda (`npm run deploy-lambda`) e só depois sobe o servidor.

> O LocalStack executa cada Lambda em um container Docker próprio. Por isso o `docker-compose.yml` monta o `/var/run/docker.sock`. **A primeira execução da Lambda pode levar de 30 s a 1 min**, porque o LocalStack precisa baixar a imagem do runtime Node.js 20. Enquanto isso, a página mostra "Processando na Lambda..." e se atualiza sozinha.

## Opção 2 — LocalStack no Docker, app local

```bash
docker run -d -p 4566:4566 \
  -e SERVICES=s3,dynamodb,lambda,iam,logs,sts \
  -v /var/run/docker.sock:/var/run/docker.sock \
  localstack/localstack

npm install
cd lambda && npm install && cd ..
npm run deploy-lambda
npm start
```

## A Lambda (`lambda/index.js`)

1. Recebe o evento do S3 com o bucket e a chave do arquivo enviado.
2. Baixa a imagem original (`GetObject`).
3. Processa com [Jimp](https://github.com/jimp-dev/jimp), uma biblioteca 100% JavaScript, sem binários nativos. Ela reduz a largura para no máximo 300 px, mantendo a proporção, e converte para escala de cinza.
4. Grava o resultado no bucket `imagens-processadas` com a **mesma chave** (`PutObject`), junto com metadados: origem, tamanho original e tamanho processado.

Formatos aceitos: JPG, PNG, GIF, BMP e TIFF. JPG, PNG e BMP mantêm o formato; GIF e TIFF são convertidos para PNG.

## Implantação (`scripts/deploy-lambda.js`)

1. Cria os buckets `imagens` e `imagens-processadas`.
2. Compacta a pasta `lambda/` (com `node_modules`) em um `.zip`.
3. Cria a função `processar-imagem` (runtime `nodejs20.x`) ou atualiza o código, se ela já existir.
4. Dá permissão ao S3 para invocar a função (`AddPermission`).
5. Configura a notificação do bucket `imagens`: `s3:ObjectCreated:*` → Lambda.

Se você alterar `lambda/index.js`, rode `npm run deploy-lambda` de novo.

## Conferindo pelo terminal (opcional)

```bash
# arquivos processados
aws --endpoint-url=http://localhost:4566 s3 ls s3://imagens-processadas

# função e gatilho
aws --endpoint-url=http://localhost:4566 lambda list-functions
aws --endpoint-url=http://localhost:4566 s3api get-bucket-notification-configuration --bucket imagens

# logs da Lambda
aws --endpoint-url=http://localhost:4566 logs tail /aws/lambda/processar-imagem --follow

# usuários
aws --endpoint-url=http://localhost:4566 dynamodb scan --table-name usuarios
```

Os logs da Lambda também aparecem no terminal do `docker compose up`, na saída do container `localstack`.

## Autenticação (DynamoDB)

A tabela `usuarios` tem os atributos `email` (chave primária), `nome`, `senhaHash`, `salt` e `criadoEm`. A senha é guardada como hash `scrypt` com salt aleatório. No login, o servidor busca o usuário pelo e-mail (`GetCommand`) e compara os hashes. Se conferirem, cria uma sessão: um token num cookie `HttpOnly`, guardado na memória do servidor.

## Rotas

| Método | Rota | Login? | Função |
|---|---|---|---|
| POST | `/api/cadastro` | não | cria conta (`nome`, `email`, `senha`) |
| POST | `/api/login` | não | autentica (`email`, `senha`) |
| POST | `/api/logout` | não | encerra a sessão |
| GET | `/api/eu` | sim | dados do usuário logado |
| GET | `/api/imagens` | sim | lista as imagens e informa se já foram processadas |
| POST | `/api/upload` | sim | envia uma imagem (campo `imagem`) |
| GET | `/ver/:chave` | sim | exibe a original |
| GET | `/download/:chave` | sim | baixa a original |
| GET | `/ver-processada/:chave` | sim | exibe a versão da Lambda |
| GET | `/download-processada/:chave` | sim | baixa a versão da Lambda |
| DELETE | `/api/imagens/:chave` | sim | exclui a original e a processada |

## Estrutura

```
server.js                 # backend Express (S3 + DynamoDB)
public/index.html         # página única
lambda/index.js           # função Lambda de processamento
lambda/package.json       # dependências da Lambda (jimp, client-s3)
scripts/deploy-lambda.js  # implanta a Lambda e liga o gatilho do S3
docker-compose.yml
```

## Variáveis de ambiente

| Variável | Padrão |
|---|---|
| AWS_ENDPOINT | http://localhost:4566 |
| S3_BUCKET | imagens |
| S3_BUCKET_PROCESSADO | imagens-processadas |
| DYNAMO_TABLE | usuarios |
| PORT | 3000 |
