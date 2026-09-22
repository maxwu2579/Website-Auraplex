'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getToken } from 'next-auth/jwt';
import { signOut } from '@/auth';
import { authSessionCookieName } from '@/lib/admin/server/auth-cookies';
import { discoverKeycloakLogoutUrl } from '@/lib/admin/server/keycloak-logout';

export async function logoutFromKeycloak(): Promise<void> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('Authentication is not configured');
  const token = await getToken({
    req: { headers: await headers() },
    secret,
    cookieName: authSessionCookieName(process.env.NODE_ENV === 'production'),
  });
  if (typeof token?.idToken !== 'string') {
    throw new Error('ID token unavailable; full logout cannot be confirmed');
  }
  const endSessionUrl = await discoverKeycloakLogoutUrl(token.idToken);
  await signOut({ redirect: false });
  redirect(endSessionUrl);
}
