import { createHash } from 'node:crypto';
import {
  uploadMediaForExtension,
  type RecentUpload,
  type UploadMediaRoute,
  type UploadStatus,
} from '@/lib/admin/upload-contract';
import { toQdrantSourceKey } from '@/lib/admin/source-key';
import type { QdrantEvidenceAdapter } from '@/lib/admin/server/qdrant';
import type { StoredObject } from '@/lib/admin/server/storage';

export function deriveUploadStatus(input: {
  stored: boolean;
  ingestionCapability?: UploadMediaRoute['ingestionCapability'];
  processedEvidence: boolean;
  explicitFailure?: boolean;
}): UploadStatus {
  if (input.explicitFailure) return 'failed';
  if (!input.stored) return 'unknown';
  if (input.ingestionCapability === 'deferred') return 'queued';
  if (input.ingestionCapability !== 'supported') return 'unknown';
  return input.processedEvidence ? 'processed' : 'pending';
}

function fallbackUploadId(object: StoredObject): string {
  return createHash('sha256')
    .update(`${object.bucket}/${object.key}`)
    .digest('hex')
    .slice(0, 24);
}

export async function buildRecentUpload(
  object: StoredObject,
  qdrant: QdrantEvidenceAdapter | null,
): Promise<RecentUpload> {
  const filename = object.key.split('/').pop() ?? object.key;
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const media = uploadMediaForExtension(extension);
  const sourceKey = toQdrantSourceKey(object);
  const processedEvidence = qdrant && media?.ingestionCapability === 'supported'
    ? await qdrant.hasProcessedEvidence(sourceKey)
    : false;

  return {
    uploadId: object.metadata['upload-id'] || fallbackUploadId(object),
    bucket: object.bucket,
    key: object.key,
    sourceKey,
    filename,
    size: object.size,
    uploadedAt: object.lastModified?.toISOString() ?? null,
    ingestionCapability: media?.ingestionCapability ?? 'deferred',
    status: deriveUploadStatus({
      stored: true,
      ingestionCapability: media?.ingestionCapability,
      processedEvidence,
    }),
  };
}
