import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type { UploadBucket } from '@/lib/admin/upload-contract';
import { getMinioConfig, type MinioConfig } from '@/lib/admin/server/config';

export interface PutStoredObjectInput {
  bucket: UploadBucket;
  key: string;
  body: Readable;
  contentLength: number;
  contentType: string;
  metadata: Record<string, string>;
  signal?: AbortSignal;
}

export interface StoredObject {
  bucket: UploadBucket;
  key: string;
  size: number;
  lastModified: Date | null;
  metadata: Record<string, string>;
}

export interface StorageAdapter {
  putObject(input: PutStoredObjectInput): Promise<{ etag?: string }>;
  listObjects(bucket: UploadBucket, limit?: number): Promise<StoredObject[]>;
  deleteObject(bucket: UploadBucket, key: string): Promise<void>;
}

type S3Sender = Pick<S3Client, 'send'>;

function normalizeMetadata(metadata?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export class S3StorageAdapter implements StorageAdapter {
  constructor(private readonly client: S3Sender) {}

  async putObject(input: PutStoredObjectInput): Promise<{ etag?: string }> {
    const output = await this.client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: input.contentLength,
        ContentType: input.contentType,
        Metadata: input.metadata,
      }),
      { abortSignal: input.signal },
    );
    return { etag: output.ETag };
  }

  async deleteObject(bucket: UploadBucket, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async listObjects(bucket: UploadBucket, limit = 50): Promise<StoredObject[]> {
    const objects: Array<{
      Key: string;
      Size?: number;
      LastModified?: Date;
    }> = [];
    let continuationToken: string | undefined;

    do {
      const output = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: 1_000,
          ContinuationToken: continuationToken,
        }),
      );
      objects.push(
        ...(output.Contents ?? []).filter(
          (item): item is typeof item & { Key: string } => Boolean(item.Key),
        ),
      );
      continuationToken = output.IsTruncated
        ? output.NextContinuationToken
        : undefined;
    } while (continuationToken);

    objects.sort(
      (left, right) =>
        (right.LastModified?.getTime() ?? 0) -
        (left.LastModified?.getTime() ?? 0),
    );
    const recent = objects.slice(0, Math.max(0, limit));

    return Promise.all(
      recent.map(async (item) => {
        const head = await this.client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: item.Key }),
        );
        return {
          bucket,
          key: item.Key,
          size: item.Size ?? head.ContentLength ?? 0,
          lastModified: item.LastModified ?? head.LastModified ?? null,
          metadata: normalizeMetadata(head.Metadata),
        };
      }),
    );
  }
}

export function createStorageAdapter(
  config: MinioConfig = getMinioConfig(),
): StorageAdapter {
  return new S3StorageAdapter(
    new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    }),
  );
}
