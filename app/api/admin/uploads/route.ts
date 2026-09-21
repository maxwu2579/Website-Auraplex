import { NextRequest } from 'next/server';
import { getUploads, putUpload } from '@/lib/admin/server/upload-service';

export async function PUT(request: NextRequest) {
  return putUpload(request);
}

export async function GET(request: NextRequest) {
  return getUploads(request);
}
