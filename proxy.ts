import createMiddleware from 'next-intl/middleware';
import { getToken } from 'next-auth/jwt';
import { NextRequest, NextResponse } from 'next/server';
import { routing } from './lib/navigation';
import { authSessionCookieName } from './lib/admin/server/auth-cookies';
import { canUpload } from './lib/admin/server/authorization';

const localeProxy = createMiddleware(routing);

export function isProtectedAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/') ||
    pathname === '/api/admin' || pathname.startsWith('/api/admin/');
}

export function adminGuardStatus(groups: unknown): 200 | 401 | 403 {
  if (!Array.isArray(groups)) return 401;
  return canUpload({
    userId: 'proxy',
    groups: groups.filter((group): group is string => typeof group === 'string'),
  }) ? 200 : 403;
}

export default async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (!isProtectedAdminPath(pathname)) return localeProxy(request);

  const isApi = pathname === '/api/admin' || pathname.startsWith('/api/admin/');
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return new NextResponse('Authentication is not configured', { status: 503 });
  }
  const token = await getToken({
    req: request,
    secret,
    cookieName: authSessionCookieName(process.env.NODE_ENV === 'production'),
  });
  const status = token ? adminGuardStatus(token.groups) : 401;
  if (status === 200) return NextResponse.next();
  if (isApi) {
    return NextResponse.json(
      { ok: false, code: status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', error: 'Access denied' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (status === 403) return new NextResponse('Forbidden', { status: 403 });
  const login = new URL('/api/auth/signin/keycloak', request.url);
  login.searchParams.set('callbackUrl', new URL(pathname, request.url).toString());
  return NextResponse.redirect(login);
}

export const config = {
  // Public i18n plus explicit admin pages/APIs. Auth.js itself is excluded.
  matcher: ['/((?!api|_next|_vercel|studio|admin|.*\\..*).*)', '/admin/:path*', '/api/admin/:path*'],
};
