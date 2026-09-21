import type { UploadObjectLocation } from '@/lib/admin/upload-contract';

/**
 * Current schema assumption: Qdrant payload.source_key stores the object key
 * relative to its MinIO bucket. Keep this mapper isolated until the production
 * ingest schema is confirmed by Friendy.
 */
export function toQdrantSourceKey(
  location: Pick<UploadObjectLocation, 'bucket' | 'key'>,
): string {
  return location.key;
}
