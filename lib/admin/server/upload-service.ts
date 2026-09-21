import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { NextResponse } from 'next/server';
import {
  UPLOAD_BUCKETS,
  type RecentUploadsResponse,
  type UploadSuccessResponse,
} from '@/lib/admin/upload-contract';
import { normalizeUploadError } from '@/lib/admin/upload-errors';
import {
  createUploadByteLimitStream,
  prepareUploadRequest,
} from '@/lib/admin/upload-validation';
import {
  authenticateAdminRequest,
  type AdminIdentity,
} from '@/lib/admin/server/authorization';
import {
  jsonAuditLogger,
  requestIp,
  type AuditLogger,
} from '@/lib/admin/server/audit';
import {
  doubleSubmitCsrfValidator,
  type CsrfValidator,
} from '@/lib/admin/server/csrf';
import { tryGetQdrantConfig } from '@/lib/admin/server/config';
import {
  createQdrantAdapter,
  type QdrantEvidenceAdapter,
} from '@/lib/admin/server/qdrant';
import {
  uploadRateLimiter,
  type UploadRateLimiter,
} from '@/lib/admin/server/rate-limit';
import {
  createStorageAdapter,
  type StorageAdapter,
} from '@/lib/admin/server/storage';
import { buildRecentUpload } from '@/lib/admin/server/status';

export interface UploadServiceDependencies {
  authenticate: () => Promise<AdminIdentity>;
  csrf: CsrfValidator;
  rateLimiter: UploadRateLimiter;
  audit: AuditLogger;
  storage: () => StorageAdapter;
  qdrant: () => QdrantEvidenceAdapter | null;
  createUploadId: () => string;
}

const defaultDependencies: UploadServiceDependencies = {
  authenticate: authenticateAdminRequest,
  csrf: doubleSubmitCsrfValidator,
  rateLimiter: uploadRateLimiter,
  audit: jsonAuditLogger,
  storage: createStorageAdapter,
  qdrant: () => {
    const config = tryGetQdrantConfig();
    return config ? createQdrantAdapter(config) : null;
  },
  createUploadId: randomUUID,
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function errorResponse(error: unknown) {
  const normalized = normalizeUploadError(error);
  return json(normalized.body, normalized.status);
}

function writeAuditSafely(audit: AuditLogger, event: Parameters<AuditLogger['write']>[0]) {
  try {
    audit.write(event);
  } catch {
    // Upload outcome must not be changed by a stdout logging failure.
  }
}

export async function putUpload(
  request: Request,
  dependencies: UploadServiceDependencies = defaultDependencies,
): Promise<Response> {
  let identity: AdminIdentity | null = null;
  let auditKey = 'unresolved';
  let auditSize = 0;

  try {
    identity = await dependencies.authenticate();
    if (!request.body) {
      return json(
        { ok: false, code: 'MALFORMED_REQUEST', error: 'A raw file body is required' },
        400,
      );
    }

    const prepared = prepareUploadRequest(request.headers);
    await dependencies.csrf.verify(request);
    dependencies.rateLimiter.consume(identity.userId, prepared.metadata.declaredSize);

    const uploadId = dependencies.createUploadId();
    auditKey = prepared.location.key;
    auditSize = prepared.metadata.declaredSize;
    const limitedWebStream = request.body.pipeThrough(createUploadByteLimitStream());
    const nodeStream = Readable.fromWeb(
      limitedWebStream as unknown as NodeReadableStream<Uint8Array>,
    );

    await dependencies.storage().putObject({
      bucket: prepared.location.bucket,
      key: prepared.location.key,
      body: nodeStream,
      contentLength: prepared.metadata.declaredSize,
      contentType: prepared.media.canonicalMimeType,
      metadata: {
        'upload-id': uploadId,
        'product-line': prepared.metadata.productLine,
        'product-id': prepared.metadata.productId,
        'original-filename': encodeURIComponent(prepared.metadata.originalFilename),
        'safe-filename': prepared.safeFilename,
        'mime-type': prepared.media.canonicalMimeType,
        'ingestion-capability': prepared.media.ingestionCapability,
      },
    });

    writeAuditSafely(dependencies.audit, {
      user: identity.userId,
      action: 'upload.accepted',
      key: auditKey,
      size: auditSize,
      ip: requestIp(request.headers),
      timestamp: new Date().toISOString(),
    });

    const response: UploadSuccessResponse = {
      ok: true,
      uploadId,
      bucket: prepared.location.bucket,
      key: prepared.location.key,
      sourceKey: prepared.location.sourceKey,
      status: prepared.media.ingestionCapability === 'supported' ? 'pending' : 'queued',
    };
    return json(response);
  } catch (error) {
    if (identity) {
      writeAuditSafely(dependencies.audit, {
        user: identity.userId,
        action: 'upload.failed',
        key: auditKey,
        size: auditSize,
        ip: requestIp(request.headers),
        timestamp: new Date().toISOString(),
      });
    }
    return errorResponse(error);
  }
}

export async function getUploads(
  _request: Request,
  dependencies: UploadServiceDependencies = defaultDependencies,
): Promise<Response> {
  try {
    await dependencies.authenticate();
    const storage = dependencies.storage();
    const qdrant = dependencies.qdrant();
    const stored = (
      await Promise.all(UPLOAD_BUCKETS.map((bucket) => storage.listObjects(bucket)))
    ).flat();
    const uploads = await Promise.all(
      stored.map((object) => buildRecentUpload(object, qdrant)),
    );
    uploads.sort((left, right) =>
      (right.uploadedAt ?? '').localeCompare(left.uploadedAt ?? ''),
    );

    const response: RecentUploadsResponse = {
      ok: true,
      uploads,
      qdrantAvailable: qdrant !== null,
    };
    return json(response);
  } catch (error) {
    return errorResponse(error);
  }
}
