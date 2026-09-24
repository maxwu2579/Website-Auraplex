import { UploadPanel } from '@/components/admin/upload-panel';
import { MACHINES } from '@/lib/catalog';
import { authenticateAdminRequest, canViewAllUploads } from '@/lib/admin/server/authorization';
import { UploadContractError } from '@/lib/admin/upload-errors';
import { getServerUploadMaxMb } from '@/lib/admin/server/upload-limit';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { Suspense } from 'react';

async function AuthorizedUploadPage() {
  // Keep Keycloak/session validation on the request path, never at build time.
  await connection();
  let canDelete = false;
  try {
    canDelete = canViewAllUploads(await authenticateAdminRequest());
  } catch (error) {
    if (error instanceof UploadContractError && error.status === 401) {
      redirect('/api/auth/signin/keycloak?callbackUrl=/admin/upload');
    }
    if (error instanceof UploadContractError && error.status === 403) notFound();
    throw error;
  }
  const products = MACHINES.map(({ id, name, slug, category }) => ({
    id,
    name,
    slug,
    category,
  }));

  return <UploadPanel products={products} canDelete={canDelete} serverMaxUploadMb={getServerUploadMaxMb()} />;
}

export default function AdminUploadPage() {
  // The fallback contains no product/admin data. Authentication completes on
  // the server before the client upload workspace is constructed.
  return <Suspense fallback={null}><AuthorizedUploadPage /></Suspense>;
}
