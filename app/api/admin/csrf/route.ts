import { NextResponse } from 'next/server';
import { normalizeUploadError } from '@/lib/admin/upload-errors';
import type { UploadApiErrorStatus } from '@/lib/admin/upload-contract';
import { authenticateAdminRequest } from '@/lib/admin/server/authorization';
import {
  ADMIN_CSRF_COOKIE,
  adminCsrfCookieOptions,
  issueCsrfToken,
} from '@/lib/admin/server/csrf';

function errorJson(body: unknown, status: UploadApiErrorStatus) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET() {
  try {
    await authenticateAdminRequest();
    const csrfToken = issueCsrfToken();
    const response = NextResponse.json(
      { ok: true, csrfToken },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    response.cookies.set(
      ADMIN_CSRF_COOKIE,
      csrfToken,
      adminCsrfCookieOptions(process.env.NODE_ENV === 'production'),
    );
    return response;
  } catch (error) {
    const normalized = normalizeUploadError(error);
    return errorJson(normalized.body, normalized.status);
  }
}
