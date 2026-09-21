import type { Category } from '@/lib/catalog';

export type ProductLine = Category;

export type UploadStatus =
  | 'queued'
  | 'pending'
  | 'processed'
  | 'failed'
  | 'unknown';

export type UiUploadQueueStatus = 'ready' | 'uploading' | 'uploaded' | 'failed';

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export const UPLOAD_HEADERS = {
  filename: 'x-upload-filename',
  productLine: 'x-product-line',
  productId: 'x-product-id',
  csrfToken: 'x-csrf-token',
} as const;

export interface UploadRequestMetadata {
  productLine: ProductLine;
  productId: string;
  originalFilename: string;
  declaredMimeType: string;
  declaredSize: number;
  csrfToken: string;
}

export interface UploadSuccessResponse {
  ok: true;
  uploadId: string;
  sourceKey: string;
  status: UploadStatus;
}

export type UploadApiErrorCode =
  | 'MALFORMED_REQUEST'
  | 'MISSING_CONTENT_LENGTH'
  | 'INVALID_CONTENT_LENGTH'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INVALID_FILENAME'
  | 'INVALID_PRODUCT'
  | 'PRODUCT_LINE_MISMATCH'
  | 'MISSING_CSRF_TOKEN'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'BACKEND_NOT_CONFIGURED'
  | 'INTERNAL_ERROR';

export type UploadApiErrorStatus =
  | 400
  | 401
  | 403
  | 413
  | 415
  | 429
  | 500
  | 503;

export const UPLOAD_ERROR_STATUS = {
  MALFORMED_REQUEST: 400,
  MISSING_CONTENT_LENGTH: 400,
  INVALID_CONTENT_LENGTH: 400,
  EMPTY_FILE: 400,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INVALID_FILENAME: 400,
  INVALID_PRODUCT: 400,
  PRODUCT_LINE_MISMATCH: 400,
  MISSING_CSRF_TOKEN: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  BACKEND_NOT_CONFIGURED: 503,
  INTERNAL_ERROR: 500,
} as const satisfies Record<UploadApiErrorCode, UploadApiErrorStatus>;

export interface UploadApiErrorResponse {
  ok: false;
  code: UploadApiErrorCode;
  error: string;
}

export type UploadApiResponse = UploadSuccessResponse | UploadApiErrorResponse;

export interface UploadObjectLocation {
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
}

export type UploadBucket =
  | 'auraplex-raw-pdf'
  | 'auraplex-raw-image'
  | 'auraplex-raw-video';

export interface UploadMediaRoute {
  bucket: UploadBucket;
  canonicalMimeType: string;
  acceptedExtensions: readonly string[];
  ingestionCapability: 'supported' | 'deferred';
}
