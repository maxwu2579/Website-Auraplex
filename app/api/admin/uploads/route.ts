import { NextRequest, NextResponse } from 'next/server';
import { createUploadErrorBody, normalizeUploadError } from '@/lib/admin/upload-errors';
import type { UploadApiErrorStatus } from '@/lib/admin/upload-contract';
import { prepareUploadRequest } from '@/lib/admin/upload-validation';

function json(body: unknown, status: UploadApiErrorStatus) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function PUT(request: NextRequest) {
  try {
    if (!request.body) {
      return json(
        createUploadErrorBody('MALFORMED_REQUEST', 'A raw file body is required'),
        400,
      );
    }

    // Day 1 establishes and validates the single-file raw-body contract. The
    // body is deliberately not buffered or consumed until the MinIO streaming
    // adapter and authentication boundary are connected. That adapter must
    // pipe through createUploadByteLimitStream() before writing to storage.
    prepareUploadRequest(request.headers);

    return json(
      createUploadErrorBody(
        'BACKEND_NOT_CONFIGURED',
        'Upload storage and authentication are not configured in this build',
      ),
      503,
    );
  } catch (error) {
    const normalized = normalizeUploadError(error);
    return json(normalized.body, normalized.status);
  }
}
