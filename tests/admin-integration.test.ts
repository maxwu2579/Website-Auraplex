import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
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
import { createStorageAdapter, S3StorageAdapter, type StorageAdapter } from '../lib/admin/server/storage';
import {
  getUploads,
  putUpload,
  type UploadServiceDependencies,
} from '../lib/admin/server/upload-service';
import { deriveUploadStatus } from '../lib/admin/server/status';
import { deleteUpload, type DeleteDependencies } from '../lib/admin/server/delete-service';
import { UPLOAD_METADATA } from '../lib/admin/server/object-metadata';
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
      groups: ['auraplex-uploader'],
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
    async deleteObject() {},
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
    async deleteObject() {},
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
    async deleteObject() {},
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
    async deleteObject() {},
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
    async deleteObject() {},
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

test('GET and DELETE independently reject missing sessions', async () => {
  const anonymous = async (): Promise<never> => { throw new UploadContractError(401, 'UNAUTHENTICATED', 'Authentication is required'); };
  const storage: StorageAdapter = {
    async putObject() { throw new Error('storage must not be reached'); },
    async listObjects() { throw new Error('storage must not be reached'); },
    async deleteObject() { throw new Error('storage must not be reached'); },
  };
  assert.equal((await getUploads(new Request('http://localhost/api/admin/uploads'), dependencies(storage, { authenticate: anonymous }))).status, 401);
  assert.equal((await deleteUpload(deleteRequest(), deleteDependencies({ authenticate: anonymous, storage: () => storage }))).status, 401);
});

test('accepted non-PDF files are stored and remain pending', async () => {
  const docx = new Uint8Array(30 + 17);
  docx.set([0x50, 0x4b, 0x03, 0x04], 0);
  docx[26] = 17;
  docx.set(new TextEncoder().encode('word/document.xml'), 30);
  const cases = [
    { name: 'manual.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: docx, bucket: 'auraplex-raw-pdf' },
    { name: 'diagram.png', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]), bucket: 'auraplex-raw-image' },
    { name: 'photo.jpg', mime: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]), bucket: 'auraplex-raw-image' },
    { name: 'demo.mp4', mime: 'video/mp4', bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]), bucket: 'auraplex-raw-video' },
  ];
  for (const item of cases) {
    let saved: Parameters<StorageAdapter['putObject']>[0] | undefined;
    const storage: StorageAdapter = {
      async putObject(input) { saved = input; for await (const _chunk of input.body) { /* drain */ } return {}; },
      async listObjects() { return []; },
      async deleteObject() {},
    };
    const request = new Request('http://localhost/api/admin/uploads', {
      method: 'PUT', body: item.bytes.slice().buffer,
      headers: {
        'content-length': String(item.bytes.length), 'content-type': item.mime,
        'x-csrf-token': 'test', 'x-product-id': '6470625', 'x-product-line': 'labelling',
        'x-upload-filename': encodeURIComponent(item.name),
      },
    });
    const response = await putUpload(request, dependencies(storage));
    assert.equal(response.status, 200, item.name);
    assert.equal((await response.json()).status, 'pending');
    assert.equal(saved?.bucket, item.bucket);
    assert.equal(saved?.metadata[UPLOAD_METADATA.ingestionCapability], 'deferred');
  }
});

test('browser cancellation is propagated to the storage adapter', async () => {
  const controller = new AbortController();
  let sawStorage = false;
  const storage: StorageAdapter = {
    async putObject(input) {
      sawStorage = true;
      assert.equal(input.signal, controller.signal);
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('upstream aborted')), { once: true });
        controller.abort();
      });
      return {};
    },
    async listObjects() { return []; },
    async deleteObject() {},
  };
  const request = new Request('http://localhost/api/admin/uploads', {
    method: 'PUT', body: PDF_BYTES.slice().buffer,
    signal: controller.signal,
    headers: {
      'content-length': String(PDF_BYTES.length), 'content-type': 'application/pdf',
      'x-csrf-token': 'test', 'x-product-id': '6470625', 'x-product-line': 'labelling',
      'x-upload-filename': encodeURIComponent('manual.pdf'),
    },
  });
  const response = await putUpload(request, dependencies(storage));
  assert.equal(sawStorage, true);
  assert.notEqual(response.status, 200);
});

test('rejects oversized declarations before opening storage', async () => {
  let storageUsed = false;
  const storage: StorageAdapter = {
    async putObject() { storageUsed = true; return {}; },
    async listObjects() { return []; },
    async deleteObject() {},
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
  let passedSignal: AbortSignal | undefined;
  const adapter = new S3StorageAdapter({
    send: async (value: unknown, options?: { abortSignal?: AbortSignal }) => {
      command = value;
      passedSignal = options?.abortSignal;
      return { ETag: 'etag' };
    },
  } as never);
  const controller = new AbortController();
  await adapter.putObject({
    bucket: 'auraplex-raw-pdf',
    key: 'labelling/product/manual.pdf',
    body: Readable.from([Buffer.from('pdf')]),
    contentLength: 3,
    contentType: 'application/pdf',
    metadata: { 'product-id': '123' },
    signal: controller.signal,
  });
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Bucket, 'auraplex-raw-pdf');
  assert.equal(command.input.Key, 'labelling/product/manual.pdf');
  assert.equal(command.input.Metadata?.['product-id'], '123');
  assert.equal(passedSignal, controller.signal);
  controller.abort();
  assert.equal(passedSignal.aborted, true);
});

test('S3 adapter sends a DeleteObjectCommand for the exact bucket and key', async () => {
  let command: unknown;
  const adapter = new S3StorageAdapter({ send: async (value: unknown) => { command = value; return {}; } } as never);
  await adapter.deleteObject('auraplex-raw-pdf', 'labelling/flexy-applicator/manual.pdf');
  assert.ok(command instanceof DeleteObjectCommand);
  assert.equal(command.input.Key, 'labelling/flexy-applicator/manual.pdf');
});

test('MinIO client keeps path-style addressing enabled', () => {
  const adapter = createStorageAdapter({
    endpoint: 'http://minio.example.test:9000',
    region: 'us-east-1', accessKey: 'test-only', secretKey: 'test-only',
  });
  const client = (adapter as unknown as { client: { config: { forcePathStyle: boolean } } }).client;
  assert.equal(client.config.forcePathStyle, true);
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
  assert.equal(deriveUploadStatus({ stored: true, ingestionCapability: 'deferred', processedEvidence: false }), 'pending');
  assert.equal(deriveUploadStatus({ stored: true, ingestionCapability: 'supported', processedEvidence: false }), 'pending');
  assert.equal(deriveUploadStatus({ stored: true, ingestionCapability: 'supported', processedEvidence: true }), 'processed');
  assert.equal(deriveUploadStatus({ stored: false, ingestionCapability: 'supported', processedEvidence: false }), 'unsupported');
  assert.equal(deriveUploadStatus({ stored: true, processedEvidence: false }), 'unsupported');
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

test('Qdrant deletion waits for exact source-key filter completion', async () => {
  let collection = '';
  let options: unknown;
  const qdrant = new QdrantRestEvidenceAdapter({
    async delete(name: string, input: unknown) {
      collection = name;
      options = input;
      return { status: 'completed' };
    },
  } as never, 'uploads');
  await qdrant.deleteBySourceKey('labelling/flexy-applicator/manual.pdf');
  assert.equal(collection, 'uploads');
  assert.deepEqual(options, {
    filter: { must: [{ key: 'source_key', match: { value: 'labelling/flexy-applicator/manual.pdf' } }] },
    wait: true,
  });
});

test('GET status gives uploaders own objects only and admins all objects', async () => {
  const storage: StorageAdapter = {
    async putObject() { return {}; },
    async deleteObject() {},
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
    async deleteBySourceKey() {},
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
      authenticate: async () => ({ userId: 'admin-1', groups: ['auraplex-admin'] }),
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

function deleteRequest(key = 'labelling/flexy-applicator/manual.pdf') {
  return new Request('http://localhost/api/admin/uploads', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket: 'auraplex-raw-pdf', key }),
  });
}

function deleteDependencies(overrides: Partial<DeleteDependencies> = {}): DeleteDependencies {
  return {
    authenticate: async () => ({ userId: 'admin-1', groups: ['auraplex-admin'] }),
    csrf: { verify() {} },
    storage: () => ({
      async putObject() { return {}; },
      async listObjects() { return []; },
      async deleteObject() {},
    }),
    qdrant: () => ({ async hasProcessedEvidence() { return false; }, async deleteBySourceKey() {} }),
    audit: { write() {} },
    ...overrides,
  };
}

test('Admin delete removes exact Qdrant source before the MinIO object', async () => {
  const calls: string[] = [];
  const target = 'labelling/flexy-applicator/manual.pdf';
  const response = await deleteUpload(deleteRequest(target), deleteDependencies({
    qdrant: () => ({ async hasProcessedEvidence() { return false; }, async deleteBySourceKey(key) { calls.push(`qdrant:${key}`); } }),
    storage: () => ({ async putObject() { return {}; }, async listObjects() { return []; }, async deleteObject(bucket, key) { calls.push(`minio:${bucket}/${key}`); } }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [`qdrant:${target}`, `minio:auraplex-raw-pdf/${target}`]);
});

test('Admin delete denies Uploader and rejects traversal before external operations', async () => {
  let used = false;
  const deps = deleteDependencies({
    authenticate: async () => ({ userId: 'uploader', groups: ['auraplex-uploader'] }),
    storage: () => { used = true; throw new Error('must not open storage'); },
  });
  assert.equal((await deleteUpload(deleteRequest(), deps)).status, 403);
  assert.equal(used, false);
  const invalid = await deleteUpload(deleteRequest('../manual.pdf'), deleteDependencies({
    storage: () => { used = true; throw new Error('must not open storage'); },
  }));
  assert.equal(invalid.status, 400);
  assert.equal(used, false);
});

test('Admin delete reports partial failure without leaking upstream details', async () => {
  const response = await deleteUpload(deleteRequest(), deleteDependencies({
    storage: () => ({ async putObject() { return {}; }, async listObjects() { return []; }, async deleteObject() { throw new Error('secret minio.internal bucket'); } }),
  }));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, 'PARTIAL_DELETE');
  assert.doesNotMatch(JSON.stringify(body), /secret|minio\.internal/i);
});

test('Admin delete does not remove MinIO when Qdrant cleanup fails', async () => {
  let minioCalled = false;
  const response = await deleteUpload(deleteRequest(), deleteDependencies({
    qdrant: () => ({ async hasProcessedEvidence() { return false; }, async deleteBySourceKey() { throw new Error('secret qdrant.internal'); } }),
    storage: () => ({ async putObject() { return {}; }, async listObjects() { return []; }, async deleteObject() { minioCalled = true; } }),
  }));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, 'INTERNAL_ERROR');
  assert.equal(minioCalled, false);
});

test('stored object metadata uses the shared dash-case schema', () => {
  for (const value of Object.values(UPLOAD_METADATA)) assert.match(value, /^[a-z]+(?:-[a-z]+)*$/);
});
