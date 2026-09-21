import { MACHINES, PRODUCT_CATEGORIES, type Category } from '@/lib/catalog';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_HEADERS,
  UPLOAD_MEDIA_ROUTES,
  type ProductLine,
  type UploadMediaRoute,
  type UploadObjectLocation,
  type UploadRequestMetadata,
} from '@/lib/admin/upload-contract';
import { UploadContractError } from '@/lib/admin/upload-errors';
import { toQdrantSourceKey } from '@/lib/admin/source-key';

const PRODUCT_LINES = new Set<Category>(PRODUCT_CATEGORIES);

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) {
    throw new UploadContractError(
      400,
      'MALFORMED_REQUEST',
      `Missing required header: ${name}`,
    );
  }
  return value;
}

function decodeFilenameHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new UploadContractError(
      400,
      'INVALID_FILENAME',
      'Filename header is not valid UTF-8 percent-encoding',
    );
  }
}

function sanitizeSegment(value: string, fallback?: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

  if (normalized) return normalized;
  if (fallback) return fallback;
  throw new UploadContractError(400, 'INVALID_FILENAME', 'Filename is empty after sanitization');
}

export function parseProductLine(value: string): ProductLine {
  if (!PRODUCT_LINES.has(value as Category)) {
    throw new UploadContractError(
      400,
      'MALFORMED_REQUEST',
      'Product line is not valid',
    );
  }
  return value as ProductLine;
}

export function resolveUploadProduct(productId: string, productLine: ProductLine) {
  const product = MACHINES.find((machine) => machine.id === productId);
  if (!product) {
    throw new UploadContractError(400, 'INVALID_PRODUCT', 'Product ID does not exist');
  }
  if (product.category !== productLine) {
    throw new UploadContractError(
      400,
      'PRODUCT_LINE_MISMATCH',
      'Product does not belong to the selected product line',
    );
  }
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    category: product.category,
  };
}

export function sanitizeUploadFilename(originalFilename: string): string {
  const trimmed = originalFilename.trim();
  if (!trimmed || /[\\/\0-\x1f\x7f]/.test(trimmed)) {
    throw new UploadContractError(
      400,
      'INVALID_FILENAME',
      'Filename contains a path separator or control character',
    );
  }

  const lastDot = trimmed.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < trimmed.length - 1;
  const rawStem = hasExtension ? trimmed.slice(0, lastDot) : trimmed;
  const rawExtension = hasExtension ? trimmed.slice(lastDot + 1) : '';
  const stem = sanitizeSegment(rawStem, 'file');
  const extension = rawExtension ? sanitizeSegment(rawExtension) : '';
  const reserved = new Set(['.', '..']);
  const candidate = extension ? `${stem}.${extension}` : stem;

  if (
    reserved.has(candidate) ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(candidate)
  ) {
    throw new UploadContractError(400, 'INVALID_FILENAME', 'Filename is not safe');
  }

  const maxLength = 180;
  if (candidate.length <= maxLength) return candidate;

  if (!extension) return candidate.slice(0, maxLength).replace(/[._-]+$/g, '');
  const stemBudget = maxLength - extension.length - 1;
  const shortenedStem = stem.slice(0, Math.max(stemBudget, 1)).replace(/[._-]+$/g, '');
  return `${shortenedStem || 'file'}.${extension}`;
}

export function validateDeclaredSize(rawContentLength: string | null): number {
  if (rawContentLength === null || rawContentLength.trim() === '') {
    throw new UploadContractError(
      400,
      'MISSING_CONTENT_LENGTH',
      'Content-Length is required',
    );
  }

  if (!/^\d+$/.test(rawContentLength.trim())) {
    throw new UploadContractError(
      400,
      'INVALID_CONTENT_LENGTH',
      'Content-Length must be a non-negative integer',
    );
  }

  const size = Number(rawContentLength);
  if (!Number.isSafeInteger(size)) {
    throw new UploadContractError(
      400,
      'INVALID_CONTENT_LENGTH',
      'Content-Length is outside the supported range',
    );
  }
  if (size === 0) {
    throw new UploadContractError(400, 'EMPTY_FILE', 'Empty files are not accepted');
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new UploadContractError(
      413,
      'FILE_TOO_LARGE',
      'File exceeds the 500 MB limit',
    );
  }
  return size;
}

/**
 * Counts the bytes that actually pass through an upload stream. This is kept
 * separate from the Content-Length preflight so the future MinIO adapter can
 * pipe the request body without buffering the whole file in Node.js memory.
 */
export function createUploadByteLimitStream(
  maxBytes: number = MAX_UPLOAD_BYTES,
  expectedBytes?: number,
): TransformStream<Uint8Array, Uint8Array> {
  let receivedBytes = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBytes) {
        throw new UploadContractError(
          413,
          'FILE_TOO_LARGE',
          'Received file data exceeds the 500 MB limit',
        );
      }
      if (expectedBytes !== undefined && receivedBytes > expectedBytes) {
        throw new UploadContractError(
          400,
          'SIZE_MISMATCH',
          'Received file size does not match Content-Length',
        );
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (expectedBytes !== undefined && receivedBytes !== expectedBytes) {
        throw new UploadContractError(
          400,
          'SIZE_MISMATCH',
          'Received file size does not match Content-Length',
        );
      }
    },
  });
}

export function resolveUploadMedia(
  declaredMimeType: string,
  safeFilename: string,
): UploadMediaRoute {
  const mime = declaredMimeType.split(';', 1)[0].trim().toLowerCase();
  const route = UPLOAD_MEDIA_ROUTES[mime];
  const extension = safeFilename.split('.').pop()?.toLowerCase() ?? '';

  if (!route || !route.acceptedExtensions.includes(extension)) {
    throw new UploadContractError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Declared media type and filename extension are not supported',
    );
  }
  return route;
}

export function buildUploadObjectLocation(input: {
  productLine: ProductLine;
  productSlug: string;
  safeFilename: string;
  media: UploadMediaRoute;
}): UploadObjectLocation {
  if (!PRODUCT_LINES.has(input.productLine)) {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Product line is not valid');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.productSlug)) {
    throw new UploadContractError(400, 'INVALID_PRODUCT', 'Product slug is not safe');
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.safeFilename)) {
    throw new UploadContractError(400, 'INVALID_FILENAME', 'Filename is not safe');
  }

  // Deliberately deterministic: the same product and sanitized filename maps
  // to the same key, so S3/MinIO currently overwrites that object. Versioning
  // semantics require product-owner confirmation before this rule changes.
  const key = [input.productLine, input.productSlug, input.safeFilename].join('/');
  const location = {
    bucket: input.media.bucket,
    key,
  };
  return { ...location, sourceKey: toQdrantSourceKey(location) };
}

export function parseUploadRequestMetadata(headers: Headers): UploadRequestMetadata {
  const productLine = parseProductLine(
    requiredHeader(headers, UPLOAD_HEADERS.productLine),
  );
  const productId = requiredHeader(headers, UPLOAD_HEADERS.productId);
  const originalFilename = decodeFilenameHeader(
    requiredHeader(headers, UPLOAD_HEADERS.filename),
  );
  const declaredMimeType = requiredHeader(headers, 'content-type')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  const declaredSize = validateDeclaredSize(headers.get('content-length'));
  const csrfToken = headers.get(UPLOAD_HEADERS.csrfToken)?.trim();
  if (!csrfToken) {
    throw new UploadContractError(
      400,
      'MISSING_CSRF_TOKEN',
      'CSRF token is required by the upload contract',
    );
  }

  return {
    productLine,
    productId,
    originalFilename,
    declaredMimeType,
    declaredSize,
    csrfToken,
  };
}

export function prepareUploadRequest(headers: Headers) {
  const metadata = parseUploadRequestMetadata(headers);
  const product = resolveUploadProduct(metadata.productId, metadata.productLine);
  const safeFilename = sanitizeUploadFilename(metadata.originalFilename);
  const media = resolveUploadMedia(metadata.declaredMimeType, safeFilename);
  const location = buildUploadObjectLocation({
    productLine: metadata.productLine,
    productSlug: product.slug,
    safeFilename,
    media,
  });

  return { metadata, product, safeFilename, media, location };
}

export const uploadMediaRoutes = UPLOAD_MEDIA_ROUTES;
