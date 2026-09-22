import type { Category } from '@/lib/catalog';

export type ProductLine = Category;

export type UploadStatus =
  | 'pending'
  | 'processed'
  | 'failed'
  | 'unsupported';

export type UiUploadQueueStatus = 'ready' | 'uploading' | 'uploaded' | 'failed' | 'unsupported';

// Build-time value shared by browser and server. Keep at 100 until proxy/Node
// limits are verified; operations can rebuild with 300 only after approval.
const configuredUploadMb = Number(process.env.NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB);
export const MAX_UPLOAD_MB = Number.isInteger(configuredUploadMb) && configuredUploadMb > 0
  ? configuredUploadMb
  : 100;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

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
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
  status: UploadStatus;
}

export interface RecentUpload {
  uploadId: string;
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
  filename: string;
  size: number;
  uploadedAt: string | null;
  ingestionCapability: UploadMediaRoute['ingestionCapability'];
  status: UploadStatus;
}

export interface DeleteUploadResponse {
  ok: true;
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
}

export interface RecentUploadsResponse {
  ok: true;
  uploads: RecentUpload[];
  qdrantAvailable: boolean;
}

export type UploadApiErrorCode =
  | 'MALFORMED_REQUEST'
  | 'MISSING_CONTENT_LENGTH'
  | 'INVALID_CONTENT_LENGTH'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'SIZE_MISMATCH'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MIME_MISMATCH'
  | 'INVALID_FILENAME'
  | 'INVALID_PRODUCT'
  | 'PRODUCT_LINE_MISMATCH'
  | 'MISSING_CSRF_TOKEN'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'BACKEND_NOT_CONFIGURED'
  | 'PARTIAL_DELETE'
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
  SIZE_MISMATCH: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  MIME_MISMATCH: 415,
  INVALID_FILENAME: 400,
  INVALID_PRODUCT: 400,
  PRODUCT_LINE_MISMATCH: 400,
  MISSING_CSRF_TOKEN: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  BACKEND_NOT_CONFIGURED: 503,
  PARTIAL_DELETE: 500,
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

export const UPLOAD_BUCKETS: readonly UploadBucket[] = [
  'auraplex-raw-pdf',
  'auraplex-raw-image',
  'auraplex-raw-video',
];

export interface UploadMediaRoute {
  bucket: UploadBucket;
  canonicalMimeType: string;
  acceptedExtensions: readonly string[];
  ingestionCapability: 'supported' | 'deferred';
}

export const UPLOAD_MEDIA_ROUTES: Readonly<Record<string, UploadMediaRoute>> = {
  'application/pdf': {
    bucket: 'auraplex-raw-pdf',
    canonicalMimeType: 'application/pdf',
    acceptedExtensions: ['pdf'],
    ingestionCapability: 'supported',
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    bucket: 'auraplex-raw-pdf',
    canonicalMimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    acceptedExtensions: ['docx'],
    ingestionCapability: 'deferred',
  },
  'image/png': {
    bucket: 'auraplex-raw-image',
    canonicalMimeType: 'image/png',
    acceptedExtensions: ['png'],
    ingestionCapability: 'deferred',
  },
  'image/jpeg': {
    bucket: 'auraplex-raw-image',
    canonicalMimeType: 'image/jpeg',
    acceptedExtensions: ['jpg', 'jpeg'],
    ingestionCapability: 'deferred',
  },
  'video/mp4': {
    bucket: 'auraplex-raw-video',
    canonicalMimeType: 'video/mp4',
    acceptedExtensions: ['mp4'],
    ingestionCapability: 'deferred',
  },
};

export const ACCEPTED_UPLOAD_EXTENSIONS = Object.freeze(
  Array.from(
    new Set(
      Object.values(UPLOAD_MEDIA_ROUTES).flatMap(
        (route) => route.acceptedExtensions,
      ),
    ),
  ),
);

export const UPLOAD_INPUT_ACCEPT = ACCEPTED_UPLOAD_EXTENSIONS
  .map((extension) => `.${extension}`)
  .join(',');

export function uploadMediaForExtension(
  extension: string,
): UploadMediaRoute | undefined {
  const normalized = extension.toLowerCase();
  return Object.values(UPLOAD_MEDIA_ROUTES).find((route) =>
    route.acceptedExtensions.includes(normalized),
  );
}
