import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  MAX_UPLOAD_BYTES,
  type UploadApiResponse,
} from '../lib/admin/upload-contract';
import { UploadContractError } from '../lib/admin/upload-errors';
import { toQdrantSourceKey } from '../lib/admin/source-key';
import {
  QdrantRestEvidenceAdapter,
  type QdrantEvidenceAdapter,
} from '../lib/admin/server/qdrant';
import { S3StorageAdapter, type StorageAdapter } from '../lib/admin/server/storage';
import {
  getUploads,
  putUpload,
  type UploadServiceDependencies,
} from '../lib/admin/server/upload-service';
import { deriveUploadStatus } from '../lib/admin/server/status';
import { canRetryUpload, queueStatusAfterResponse } from '../lib/admin/upload-ui-state';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\ncomplete-pdf-body');

function uploadRequest(
  contentLength = PDF_BYTES.byteLength,
  body: Uint8Array = PDF_BYTES,
) {
  return new NextRequest('http://localhost/api/admin/uploads', {
    method: 'PUT',
    body: body.slice().buffer as ArrayBuffer,
    headers: {
      'content-length': String(contentLength),
      'content-type': 'application/pdf',
      cookie: 'auraplex-admin-csrf=test-csrf',
      'x-csrf-token': 'test-csrf',
      'x-product-id': '6470625',
      'x-product-line': 'labelling',
      'x-upload-filename': encodeURIComponent('Product Manual.pdf'),
    },
  });
}

function dependencies(
  storage: StorageAdapter,
  overrides: Partial<UploadServiceDependencies> = {},
): UploadServiceDependencies {
  return {
    authenticate: async () => ({
      userId: 'user-1',
      email: 'user@example.test',
      roles: ['Uploader'],
    }),
    csrf: { verify() {} },
    rateLimiter: { consume() {} },
    audit: { write() {} },
    storage: () => storage,
    qdrant: () => null,
    createUploadId: () => 'upload-123',
    ...overrides,
  };
}

test('streams request bytes through the limiter and maps MinIO input', async () => {
  let receivedBytes = 0;
  let captured: Parameters<StorageAdapter['putObject']>[0] | undefined;
  const storage: StorageAdapter = {
    async putObject(input) {
      captured = input;
      for await (const chunk of input.body) {
        receivedBytes += Buffer.byteLength(chunk as Uint8Array);
      }
      return { etag: 'etag' };
    },
    async listObjects() {
      return [];
    },
  };

  const response = await putUpload(uploadRequest(), dependencies(storage));
  const body = (await response.json()) as UploadApiResponse;
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(receivedBytes, PDF_BYTES.byteLength);
  assert.equal(captured?.bucket, 'auraplex-raw-pdf');
  assert.equal(captured?.key, 'labelling/flexy-applicator/product-manual.pdf');
  assert.equal(captured?.metadata['product-line'], 'labelling');
  assert.equal(captured?.metadata['product-id'], '6470625');
  assert.equal(captured?.metadata['safe-filename'], 'product-manual.pdf');
  assert.equal(captured?.metadata['upload-id'], 'upload-123');
  assert.equal(captured?.metadata['uploaded-by'], 'user-1');
  if (body.ok) {
    assert.equal(body.status, 'pending');
    assert.equal(body.sourceKey, 'labelling/flexy-applicator/product-manual.pdf');
  }
});

test('upload service rejects a body shorter than the declared Content-Length', async () => {
  const storage: StorageAdapter = {
    async putObject(input) {
      for await (const _chunk of input.body) {
        // Drain to trigger the counting stream flush check.
      }
      return {};
    },
    async listObjects() { return []; },
  };
  const response = await putUpload(
    uploadRequest(PDF_BYTES.byteLength + 1),
    dependencies(storage),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'SIZE_MISMATCH');
});

test('does not return success before storage confirms acceptance', async () => {
  let release!: () => void;
  const accepted = new Promise<void>((resolve) => { release = resolve; });
  const storage: StorageAdapter = {
    async putObject() {
      await accepted;
      return {};
    },
    async listObjects() { return []; },
  };
  let settled = false;
  const pending = putUpload(uploadRequest(), dependencies(storage)).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  release();
  const response = await pending;
  assert.equal(response.status, 200);
});

test('maps storage failure to a stable 500 response', async () => {
  const storage: StorageAdapter = {
    async putObject() { throw new Error('internal endpoint detail'); },
    async listObjects() { return []; },
  };
  const response = await putUpload(uploadRequest(), dependencies(storage));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: 'INTERNAL_ERROR',
    error: 'The upload request could not be processed',
  });
});

test('upload service returns 401 and 403 from the authentication boundary', async () => {
  const storage: StorageAdapter = {
    async putObject() { return {}; },
    async listObjects() { return []; },
  };
  for (const expected of [
    new UploadContractError(401, 'UNAUTHENTICATED', 'Authentication is required'),
    new UploadContractError(403, 'FORBIDDEN', 'Permission is required'),
  ]) {
    const response = await putUpload(
      uploadRequest(),
      dependencies(storage, {
        authenticate: async () => { throw expected; },
      }),
    );
    assert.equal(response.status, expected.status);
    assert.equal((await response.json()).code, expected.code);
  }
});

test('rejects oversized declarations before opening storage', async () => {
  let storageUsed = false;
  const storage: StorageAdapter = {
    async putObject() { storageUsed = true; return {}; },
    async listObjects() { return []; },
  };
  const response = await putUpload(
    uploadRequest(MAX_UPLOAD_BYTES + 1),
    dependencies(storage),
  );
  assert.equal(response.status, 413);
  assert.equal(storageUsed, false);
});

test('S3 adapter sends a PutObjectCommand with the supplied stream metadata', async () => {
  let command: unknown;
  const adapter = new S3StorageAdapter({
    send: async (value: unknown) => {
      command = value;
      return { ETag: 'etag' };
    },
  } as never);
  await adapter.putObject({
    bucket: 'auraplex-raw-pdf',
    key: 'labelling/product/manual.pdf',
    body: Readable.from([Buffer.from('pdf')]),
    contentLength: 3,
    contentType: 'application/pdf',
    metadata: { 'product-id': '123' },
  });
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Bucket, 'auraplex-raw-pdf');
  assert.equal(command.input.Key, 'labelling/product/manual.pdf');
  assert.equal(command.input.Metadata?.['product-id'], '123');
});

test('S3 listing follows continuation tokens and returns newest objects first', async () => {
  const listTokens: Array<string | undefined> = [];
  const adapter = new S3StorageAdapter({
    send: async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        listTokens.push(command.input.ContinuationToken);
        if (!command.input.ContinuationToken) {
          return {
            IsTruncated: true,
            NextContinuationToken: 'next-page',
            Contents: [{
              Key: 'older.pdf',
              Size: 1,
              LastModified: new Date('2026-09-20T10:00:00Z'),
            }],
          };
        }
        return {
          IsTruncated: false,
          Contents: [{
            Key: 'newer.pdf',
            Size: 2,
            LastModified: new Date('2026-09-21T10:00:00Z'),
          }],
        };
      }
      assert.ok(command instanceof HeadObjectCommand);
      return { Metadata: { 'uploaded-by': 'user-1' } };
    },
  } as never);
  const objects = await adapter.listObjects('auraplex-raw-pdf', 2);
  assert.deepEqual(listTokens, [undefined, 'next-page']);
  assert.deepEqual(objects.map((object) => object.key), ['newer.pdf', 'older.pdf']);
});

test('status mapping never treats missing Qdrant evidence as failed', () => {
  assert.equal(deriveUploadStatus({ stored: true, ingestionCapability: 'deferred', processedEvidence: false }), 'queued');
  assert.equal(deriveUploadStatus({ stored: true, ingestionCapability: 'supported', processedEvidence: false }), 'pending');
  assert.equal(deriveUploadStatus({ stored: true, ingestionCapability: 'supported', processedEvidence: true }), 'processed');
  assert.equal(deriveUploadStatus({ stored: false, ingestionCapability: 'supported', processedEvidence: false }), 'unknown');
  assert.equal(deriveUploadStatus({ stored: true, processedEvidence: false }), 'unknown');
});

test('Qdrant adapter filters by the isolated relative source key', async () => {
  let filterValue: unknown;
  const qdrant = new QdrantRestEvidenceAdapter({
    async scroll(_collection: string, options: { filter?: { must?: Array<{ match?: { value?: unknown } }> } }) {
      filterValue = options.filter?.must?.[0]?.match?.value;
      return { points: [{ id: 1 }], next_page_offset: null };
    },
  } as never, 'uploads');
  const sourceKey = toQdrantSourceKey({
    bucket: 'auraplex-raw-pdf',
    key: 'labelling/flexy-applicator/manual.pdf',
  });
  assert.equal(await qdrant.hasProcessedEvidence(sourceKey), true);
  assert.equal(filterValue, 'labelling/flexy-applicator/manual.pdf');
});

test('GET status gives uploaders own objects only and admins all objects', async () => {
  const storage: StorageAdapter = {
    async putObject() { return {}; },
    async listObjects(bucket) {
      return bucket === 'auraplex-raw-pdf'
        ? [
            {
              bucket,
              key: 'labelling/flexy-applicator/own.pdf',
              size: 10,
              lastModified: new Date('2026-09-21T10:00:00Z'),
              metadata: { 'upload-id': 'own-id', 'uploaded-by': 'user-1' },
            },
            {
              bucket,
              key: 'labelling/flexy-applicator/other.pdf',
              size: 10,
              lastModified: new Date('2026-09-21T11:00:00Z'),
              metadata: { 'upload-id': 'other-id', 'uploaded-by': 'user-2' },
            },
            {
              bucket,
              key: 'labelling/flexy-applicator/legacy.pdf',
              size: 10,
              lastModified: new Date('2026-09-21T12:00:00Z'),
              metadata: { 'upload-id': 'legacy-id' } as Record<string, string>,
            },
          ]
        : [];
    },
  };
  const qdrant: QdrantEvidenceAdapter = {
    async hasProcessedEvidence() { return true; },
  };
  const uploaderResponse = await getUploads(
    new Request('http://localhost/api/admin/uploads'),
    dependencies(storage, { qdrant: () => qdrant }),
  );
  const uploaderBody = await uploaderResponse.json();
  assert.equal(uploaderResponse.status, 200);
  assert.deepEqual(uploaderBody.uploads.map((item: { uploadId: string }) => item.uploadId), ['own-id']);
  assert.equal(uploaderBody.uploads[0].status, 'processed');
  assert.equal(uploaderBody.qdrantAvailable, true);

  const adminResponse = await getUploads(
    new Request('http://localhost/api/admin/uploads'),
    dependencies(storage, {
      authenticate: async () => ({ userId: 'admin-1', roles: ['Admin'] }),
      qdrant: () => qdrant,
    }),
  );
  const adminBody = await adminResponse.json();
  assert.deepEqual(
    adminBody.uploads.map((item: { uploadId: string }) => item.uploadId),
    ['legacy-id', 'other-id', 'own-id'],
  );
});

test('frontend response mapping never treats a 503 error body as uploaded', () => {
  assert.equal(queueStatusAfterResponse({
    ok: false,
    code: 'BACKEND_NOT_CONFIGURED',
    error: 'MinIO is not configured',
  }), 'failed');
  assert.equal(queueStatusAfterResponse({
    ok: true,
    uploadId: '1',
    bucket: 'auraplex-raw-pdf',
    key: 'a/b.pdf',
    sourceKey: 'a/b.pdf',
    status: 'pending',
  }), 'uploaded');
  assert.equal(canRetryUpload('failed'), true);
  assert.equal(canRetryUpload('uploaded'), false);
});
