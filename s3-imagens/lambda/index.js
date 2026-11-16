/**
 * Função Lambda: processar-imagem
 *
 * Gatilho: evento s3:ObjectCreated:* no bucket "imagens".
 * Ação:    baixa a imagem, gera uma miniatura (máx. 300 px de largura) em
 *          escala de cinza e envia o resultado para o bucket "imagens-processadas"
 *          usando a mesma chave do arquivo original.
 */
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const Jimp = require("jimp");

const BUCKET_DESTINO = process.env.BUCKET_DESTINO || "imagens-processadas";
const LARGURA_MAX = parseInt(process.env.LARGURA_MAX || "300", 10);

// Dentro do LocalStack o endpoint vem por variável de ambiente injetada no container da Lambda
const endpoint =
  process.env.AWS_ENDPOINT_URL ||
  (process.env.LOCALSTACK_HOSTNAME
    ? `http://${process.env.LOCALSTACK_HOSTNAME}:${process.env.EDGE_PORT || 4566}`
    : undefined);

const s3 = new S3Client({ endpoint, forcePathStyle: true, region: process.env.AWS_REGION || "us-east-1" });

// Formatos que o Jimp consegue gravar; o resto vira PNG
const SAIDA = {
  "image/jpeg": Jimp.MIME_JPEG,
  "image/png": Jimp.MIME_PNG,
  "image/bmp": Jimp.MIME_BMP,
};

async function lerCorpo(stream) {
  const partes = [];
  for await (const p of stream) partes.push(p);
  return Buffer.concat(partes);
}

exports.handler = async (event) => {
  const resultados = [];

  for (const registro of event.Records || []) {
    const bucket = registro.s3.bucket.name;
    // chaves chegam codificadas na URL (espaço vira "+")
    const chave = decodeURIComponent(registro.s3.object.key.replace(/\+/g, " "));
    console.log(`Processando s3://${bucket}/${chave}`);

    try {
      const original = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: chave }));
      const buffer = await lerCorpo(original.Body);

      const imagem = await Jimp.read(buffer);
      const larguraOriginal = imagem.bitmap.width;
      const alturaOriginal = imagem.bitmap.height;

      if (larguraOriginal > LARGURA_MAX) imagem.resize(LARGURA_MAX, Jimp.AUTO);
      imagem.greyscale().quality(80);

      const mime = SAIDA[original.ContentType] || Jimp.MIME_PNG;
      const saida = await imagem.getBufferAsync(mime);

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET_DESTINO,
          Key: chave,
          Body: saida,
          ContentType: mime,
          Metadata: {
            origem: `${bucket}/${chave}`,
            "tamanho-original": `${larguraOriginal}x${alturaOriginal}`,
            "tamanho-processado": `${imagem.bitmap.width}x${imagem.bitmap.height}`,
          },
        })
      );

      console.log(
        `OK: ${larguraOriginal}x${alturaOriginal} -> ${imagem.bitmap.width}x${imagem.bitmap.height}, ` +
          `${buffer.length} -> ${saida.length} bytes, salvo em s3://${BUCKET_DESTINO}/${chave}`
      );
      resultados.push({ chave, ok: true });
    } catch (err) {
      console.error(`Erro ao processar ${chave}:`, err);
      resultados.push({ chave, ok: false, erro: err.message });
    }
  }

  return { processadas: resultados };
};
