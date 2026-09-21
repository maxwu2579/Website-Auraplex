import type {
  UiUploadQueueStatus,
  UploadApiResponse,
} from '@/lib/admin/upload-contract';

export function queueStatusAfterResponse(
  response: UploadApiResponse,
): UiUploadQueueStatus {
  return response.ok ? 'uploaded' : 'failed';
}

export function canRetryUpload(status: UiUploadQueueStatus): boolean {
  return status === 'failed';
}
