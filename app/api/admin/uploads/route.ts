import { NextRequest } from 'next/server';
import { getUploads, putUpload } from '@/lib/admin/server/upload-service';
import { deleteUpload } from '@/lib/admin/server/delete-service';
import { assertAdminNodeRuntime } from '@/lib/admin/server/node-runtime';

export async function PUT(request: NextRequest) {
  assertAdminNodeRuntime();
  return putUpload(request);
}

export async function GET(request: NextRequest) {
  assertAdminNodeRuntime();
  return getUploads(request);
}

export async function DELETE(request: NextRequest) {
  assertAdminNodeRuntime();
  return deleteUpload(request);
}
