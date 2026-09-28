import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand,
  PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { ObjectStoragePort } from './object-storage.port.js';

export interface S3ObjectStorageOptions {
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export function objectStorageOptionsFromEnvironment(): S3ObjectStorageOptions {
  const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY'] as const;
  if (process.env.NODE_ENV === 'production' && required.some((name) => !process.env[name])) {
    throw new Error('S3 object storage configuration is required in production.');
  }
  return {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    bucket: process.env.S3_BUCKET ?? 'uconext-exports',
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'uconext_development',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'uconext_development',
  };
}

export class S3ObjectStorage implements ObjectStoragePort {
  private readonly client: S3Client;
  private bucketReady: Promise<void> | undefined;

  constructor(private readonly options: S3ObjectStorageOptions) {
    this.client = new S3Client({ endpoint: options.endpoint, region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey } });
  }

  async put(key: string, body: Uint8Array, contentType: 'application/pdf' | 'text/csv') {
    if (process.env.NODE_ENV !== 'production') {
      this.bucketReady ??= this.ensureDevelopmentBucket();
      try { await this.bucketReady; }
      catch (error) { this.bucketReady = undefined; throw error; }
    }
    await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key,
      Body: body, ContentType: contentType }));
  }

  private async ensureDevelopmentBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
    } catch (error) {
      const status = typeof error === 'object' && error !== null && '$metadata' in error
        ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode : undefined;
      if (status !== 404) throw error;
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.options.bucket }));
      } catch (creationError) {
        const creationStatus = typeof creationError === 'object' && creationError !== null &&
          '$metadata' in creationError
          ? (creationError.$metadata as { httpStatusCode?: number }).httpStatusCode : undefined;
        if (creationStatus !== 409) throw creationError;
      }
    }
  }

  async signedGetUrl(key: string, fileName: string, contentType: string,
    expiresInSeconds: number): Promise<string> {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 300) {
      throw new Error('Invalid signed URL lifetime.');
    }
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: key,
      ResponseContentType: contentType,
      ResponseContentDisposition: `attachment; filename="${fileName}"` }),
    { expiresIn: expiresInSeconds });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }
}
