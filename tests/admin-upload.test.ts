import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { PUT } from '../app/api/admin/uploads/route';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_ERROR_STATUS,
  type ProductLine,
} from '../lib/admin/upload-contract';
import {
  buildUploadObjectLocation,
  createUploadByteLimitStream,
  resolveUploadMedia,
  resolveUploadProduct,
  sanitizeUploadFilename,
  validateDeclaredSize,
} from '../lib/admin/upload-validation';
import {
  createUploadErrorBody,
  UploadContractError,
} from '../lib/admin/upload-errors';

function expectContractError(
  callback: () => unknown,
  code: string,
  status?: number,
) {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof UploadContractError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test('resolves a real catalogue product by ID and category', () => {
  const product = resolveUploadProduct('6470625', 'labelling');
  assert.equal(product.slug, 'flexy-applicator');
  assert.equal(product.category, 'labelling');
});

test('rejects an unknown product ID', () => {
  expectContractError(
    () => resolveUploadProduct('not-a-product', 'labelling'),
    'INVALID_PRODUCT',
    400,
  );
});

test('rejects a product line and product ID mismatch', () => {
  expectContractError(
    () => resolveUploadProduct('6470625', 'packaging'),
    'PRODUCT_LINE_MISMATCH',
    400,
  );
});

test('sanitizes ordinary and Unicode filenames deterministically', () => {
  assert.equal(sanitizeUploadFilename(' Product Manual V2.PDF '), 'product-manual-v2.pdf');
  assert.equal(sanitizeUploadFilename('AR 600 中文手册.pdf'), 'ar-600.pdf');
  assert.equal(sanitizeUploadFilename('Résumé final.pdf'), 'resume-final.pdf');
});

test('rejects path traversal and control characters', () => {
  for (const filename of ['../secret.pdf', '..\\secret.pdf', '/tmp/file.pdf', 'a\0b.pdf']) {
    expectContractError(
      () => sanitizeUploadFilename(filename),
      'INVALID_FILENAME',
      400,
    );
  }
});

test('routes supported MIME types to the specified buckets', () => {
  assert.equal(resolveUploadMedia('application/pdf', 'manual.pdf').bucket, 'auraplex-raw-pdf');
  assert.equal(
    resolveUploadMedia(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'manual.docx',
    ).bucket,
    'auraplex-raw-pdf',
  );
  assert.equal(resolveUploadMedia('image/jpeg', 'photo.jpg').bucket, 'auraplex-raw-image');
  assert.equal(resolveUploadMedia('video/quicktime', 'demo.mov').bucket, 'auraplex-raw-video');
});

test('keeps storage acceptance separate from ingestion capability', () => {
  assert.equal(resolveUploadMedia('application/pdf', 'manual.pdf').ingestionCapability, 'supported');
  assert.equal(resolveUploadMedia('image/png', 'diagram.png').ingestionCapability, 'deferred');
});

test('rejects unsupported MIME types and extension mismatches', () => {
  expectContractError(
    () => resolveUploadMedia('application/octet-stream', 'manual.pdf'),
    'UNSUPPORTED_MEDIA_TYPE',
    415,
  );
  expectContractError(
    () => resolveUploadMedia('image/jpeg', 'manual.pdf'),
    'UNSUPPORTED_MEDIA_TYPE',
    415,
  );
});

test('builds the deterministic bucket and object key', () => {
  const productLine: ProductLine = 'labelling';
  const media = resolveUploadMedia('application/pdf', 'manual.pdf');
  const location = buildUploadObjectLocation({
    productLine,
    productSlug: 'flexy-applicator',
    safeFilename: 'manual.pdf',
    media,
  });

  assert.deepEqual(location, {
    bucket: 'auraplex-raw-pdf',
    key: 'labelling/flexy-applicator/manual.pdf',
    sourceKey: 'auraplex-raw-pdf/labelling/flexy-applicator/manual.pdf',
  });
});

test('rejects unsafe object key components', () => {
  const media = resolveUploadMedia('application/pdf', 'manual.pdf');
  expectContractError(
    () => buildUploadObjectLocation({
      productLine: 'labelling',
      productSlug: '../escape',
      safeFilename: 'manual.pdf',
      media,
    }),
    'INVALID_PRODUCT',
    400,
  );
});

test('validates zero, exact-limit, and over-limit file sizes', () => {
  expectContractError(() => validateDeclaredSize('0'), 'EMPTY_FILE', 400);
  assert.equal(validateDeclaredSize(String(MAX_UPLOAD_BYTES)), MAX_UPLOAD_BYTES);
  expectContractError(
    () => validateDeclaredSize(String(MAX_UPLOAD_BYTES + 1)),
    'FILE_TOO_LARGE',
    413,
  );
});

test('counts streamed bytes without buffering the complete upload', async () => {
  const allowed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3));
      controller.enqueue(new Uint8Array(2));
      controller.close();
    },
  });
  const allowedReader = allowed.pipeThrough(createUploadByteLimitStream(5)).getReader();
  let allowedBytes = 0;
  while (true) {
    const { done, value } = await allowedReader.read();
    if (done) break;
    allowedBytes += value.byteLength;
  }
  assert.equal(allowedBytes, 5);

  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.close();
    },
  });
  const oversizedReader = oversized
    .pipeThrough(createUploadByteLimitStream(5))
    .getReader();
  await assert.rejects(oversizedReader.read(), (error: unknown) => {
    assert.ok(error instanceof UploadContractError);
    assert.equal(error.code, 'FILE_TOO_LARGE');
    assert.equal(error.status, 413);
    return true;
  });
});

test('rejects missing and malformed content lengths', () => {
  expectContractError(
    () => validateDeclaredSize(null),
    'MISSING_CONTENT_LENGTH',
    400,
  );
  expectContractError(
    () => validateDeclaredSize('-1'),
    'INVALID_CONTENT_LENGTH',
    400,
  );
});

test('serializes stable API errors', () => {
  assert.deepEqual(
    createUploadErrorBody('FILE_TOO_LARGE', 'File exceeds the 500 MB limit'),
    {
      ok: false,
      code: 'FILE_TOO_LARGE',
      error: 'File exceeds the 500 MB limit',
    },
  );
  assert.equal(UPLOAD_ERROR_STATUS.UNAUTHENTICATED, 401);
  assert.equal(UPLOAD_ERROR_STATUS.FORBIDDEN, 403);
  assert.equal(UPLOAD_ERROR_STATUS.RATE_LIMITED, 429);
  assert.equal(UPLOAD_ERROR_STATUS.INTERNAL_ERROR, 500);
});

function makeUploadRequest(contentLength: number) {
  return new NextRequest('http://localhost/api/admin/uploads', {
    method: 'PUT',
    body: new Uint8Array([1]),
    headers: {
      'content-length': String(contentLength),
      'content-type': 'application/pdf',
      'x-csrf-token': 'contract-placeholder',
      'x-product-id': '6470625',
      'x-product-line': 'labelling',
      'x-upload-filename': encodeURIComponent('Product Manual.pdf'),
    },
  });
}

test('upload route fails honestly while backend integration is unavailable', async () => {
  const response = await PUT(makeUploadRequest(1));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: 'BACKEND_NOT_CONFIGURED',
    error: 'Upload storage and authentication are not configured in this build',
  });
});

test('upload route rejects an oversized declaration before backend access', async () => {
  const response = await PUT(makeUploadRequest(MAX_UPLOAD_BYTES + 1));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: 'FILE_TOO_LARGE',
    error: 'File exceeds the 500 MB limit',
  });
});
