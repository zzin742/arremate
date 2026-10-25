import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Gera a URL pré-assinada do upload.
 *
 * A assinatura vale 15 minutos: tempo de sobra para enviar um vídeo e
 * curto o bastante para um link vazado não servir depois.
 */
export function criarS3({ bucket, cliente } = {}) {
  const s3 = cliente ?? new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    forcePathStyle: true,   // LocalStack não resolve bucket por subdomínio
  });
  const nome = bucket ?? process.env.BUCKET_MIDIA ?? 'arremate-midia';

  return {
    async urlDeUpload(chave) {
      return getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: nome, Key: chave }),
        { expiresIn: 900 },
      );
    },
  };
}
