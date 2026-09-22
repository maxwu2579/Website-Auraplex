import { NextResponse } from 'next/server';
import { UPLOAD_BUCKETS, uploadMediaForExtension, type DeleteUploadResponse, type UploadBucket } from '@/lib/admin/upload-contract';
import { UploadContractError, normalizeUploadError } from '@/lib/admin/upload-errors';
import { parseProductLine, sanitizeUploadFilename } from '@/lib/admin/upload-validation';
import { authenticateDeleteRequest, requireAdminPermission, type AdminIdentity } from '@/lib/admin/server/authorization';
import { jsonAuditLogger, requestIp, type AuditLogger } from '@/lib/admin/server/audit';
import { doubleSubmitCsrfValidator, type CsrfValidator } from '@/lib/admin/server/csrf';
import { createStorageAdapter, type StorageAdapter } from '@/lib/admin/server/storage';
import { createQdrantAdapter, type QdrantEvidenceAdapter } from '@/lib/admin/server/qdrant';

const MAX_DELETE_BODY_BYTES = 2_048;

export interface DeleteDependencies {
  authenticate: () => Promise<AdminIdentity>;
  csrf: CsrfValidator;
  storage: () => StorageAdapter;
  qdrant: () => QdrantEvidenceAdapter;
  audit: AuditLogger;
}

const defaults: DeleteDependencies = {
  authenticate: authenticateDeleteRequest,
  csrf: doubleSubmitCsrfValidator,
  storage: createStorageAdapter,
  qdrant: createQdrantAdapter,
  audit: jsonAuditLogger,
};

export function validateDeleteTarget(input: unknown): { bucket: UploadBucket; key: string; sourceKey: string } {
  if (!input || typeof input !== 'object') {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Invalid delete target');
  }
  const { bucket, key } = input as { bucket?: unknown; key?: unknown };
  if (typeof bucket !== 'string' || !UPLOAD_BUCKETS.includes(bucket as UploadBucket) || typeof key !== 'string') {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Invalid delete target');
  }
  const match = /^([a-z]+)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9][a-z0-9._-]*)$/.exec(key);
  if (!match) throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Invalid object key');
  const [, productLine, , filename] = match;
  parseProductLine(productLine);
  if (sanitizeUploadFilename(filename) !== filename) {
    throw new UploadContractError(400, 'INVALID_FILENAME', 'Invalid object filename');
  }
  const extension = filename.split('.').pop() ?? '';
  const media = uploadMediaForExtension(extension);
  if (!media || media.bucket !== bucket) {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Object type does not match bucket');
  }
  return { bucket: bucket as UploadBucket, key, sourceKey: key };
}

async function readDeleteBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !request.body) {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'A JSON delete target is required');
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_DELETE_BODY_BYTES) {
        throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Delete target is too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof UploadContractError) throw error;
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Invalid JSON delete target');
  } finally {
    reader.releaseLock();
  }
}

export async function deleteUpload(
  request: Request,
  dependencies: DeleteDependencies = defaults,
): Promise<Response> {
  let identity: AdminIdentity | null = null;
  let key = 'unresolved';
  let qdrantDeleted = false;
  try {
    identity = requireAdminPermission(await dependencies.authenticate());
    await dependencies.csrf.verify(request);
    const target = validateDeleteTarget(await readDeleteBody(request));
    key = target.key;
    const qdrant = dependencies.qdrant(); // Mandatory for a consistent delete.
    const storage = dependencies.storage();
    // Delete vectors first so an S3 failure cannot leave indexed FAQ answers.
    await qdrant.deleteBySourceKey(target.sourceKey);
    qdrantDeleted = true;
    await storage.deleteObject(target.bucket, target.key);
    try {
      dependencies.audit.write({ user: identity.userId, action: 'delete.accepted', key, size: 0, ip: requestIp(request.headers), timestamp: new Date().toISOString() });
    } catch {
      // A logging outage must not claim that an already completed delete was partial.
    }
    const body: DeleteUploadResponse = { ok: true, ...target };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (identity) {
      try {
        dependencies.audit.write({ user: identity.userId, action: qdrantDeleted ? 'delete.partial' : 'delete.failed', key, size: 0, ip: requestIp(request.headers), timestamp: new Date().toISOString() });
      } catch {
        // Logging must not turn a failed delete into success or expose secrets.
      }
    }
    const normalized = qdrantDeleted
      ? normalizeUploadError(new UploadContractError(500, 'PARTIAL_DELETE', 'Delete incomplete; contact an administrator'))
      : normalizeUploadError(error);
    return NextResponse.json(normalized.body, { status: normalized.status, headers: { 'Cache-Control': 'no-store' } });
  }
}
