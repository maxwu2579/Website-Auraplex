'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getToken } from 'next-auth/jwt';
import { signOut } from '@/auth';
import { authSessionCookieName } from '@/lib/admin/server/auth-cookies';
import { tryDiscoverKeycloakLogoutUrl } from '@/lib/admin/server/keycloak-logout';

export async function logoutFromKeycloak(): Promise<void> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('Authentication is not configured');
  const token = await getToken({
    req: { headers: await headers() },
    secret,
    cookieName: authSessionCookieName(process.env.NODE_ENV === 'production'),
  });
  const endSessionUrl = await tryDiscoverKeycloakLogoutUrl(
    typeof token?.idToken === 'string' ? token.idToken : undefined,
  );
  await signOut({ redirect: false });
  redirect(endSessionUrl ?? '/en');
}
