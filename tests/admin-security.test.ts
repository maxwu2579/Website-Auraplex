import assert from 'node:assert/strict';
import test from 'node:test';
import { UploadContractError } from '../lib/admin/upload-errors';
import {
  canViewAllUploads,
  canUpload,
  extractKeycloakGroups,
  getAdminRoleMapping,
  requireUploadPermission,
} from '../lib/admin/server/authorization';
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_CSRF_COOKIE_PATH,
  adminCsrfCookieOptions,
  doubleSubmitCsrfValidator,
} from '../lib/admin/server/csrf';
import { jsonAuditLogger, requestIp } from '../lib/admin/server/audit';
import { getMinioConfig } from '../lib/admin/server/config';
import { getAdminCsrfResponse } from '../lib/admin/server/csrf-service';
import { authCookieConfig } from '../lib/admin/server/auth-cookies';
import { buildKeycloakLogoutUrl, discoverKeycloakLogoutUrl, tryDiscoverKeycloakLogoutUrl } from '../lib/admin/server/keycloak-logout';
import { adminGuardStatus, isProtectedAdminPath } from '../proxy';
import {
  InMemoryUploadRateLimiter,
  UPLOAD_RATE_LIMITS,
} from '../lib/admin/server/rate-limit';

test('authorization rejects unauthenticated and unauthorized users', () => {
  assert.throws(() => requireUploadPermission(null), (error: unknown) => {
    assert.ok(error instanceof UploadContractError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.throws(
    () => requireUploadPermission({ userId: 'viewer', groups: ['Viewer'] }),
    (error: unknown) => {
      assert.ok(error instanceof UploadContractError);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test('Uploader and Admin groups can upload with centralized mapping', () => {
  assert.equal(canUpload({ userId: 'uploader', groups: ['auraplex-uploader'] }), true);
  assert.equal(canUpload({ userId: 'admin', groups: ['auraplex-admin'] }), true);
  assert.equal(canUpload({ userId: 'viewer', groups: ['Viewer'] }), false);
  assert.equal(canViewAllUploads({ userId: 'uploader', groups: ['auraplex-uploader'] }), false);
  assert.equal(canViewAllUploads({ userId: 'admin', groups: ['auraplex-admin'] }), true);
  assert.equal(canUpload({ userId: 'nested', groups: ['/auraplex-admin'] }), false);
  assert.equal(canUpload({ userId: 'nested', groups: ['/Admin'] }, { uploader: '/Uploader', admin: '/Admin' }), true);
});

test('Keycloak group defaults follow the task spec and remain configurable', () => {
  assert.deepEqual(getAdminRoleMapping({} as NodeJS.ProcessEnv), {
    uploader: 'auraplex-uploader',
    admin: 'auraplex-admin',
  });
  assert.deepEqual(getAdminRoleMapping({
    NODE_ENV: 'test',
    KEYCLOAK_UPLOADER_ROLE: 'custom-uploader',
    KEYCLOAK_ADMIN_ROLE: 'custom-admin',
  } as NodeJS.ProcessEnv), {
    uploader: 'custom-uploader',
    admin: 'custom-admin',
  });
});

test('only validated Keycloak ID-token groups grant admin access', () => {
  const profile = {
    groups: ['/auraplex-uploader'],
    realm_access: { roles: ['realm-reader'] },
    resource_access: {
      'website-client': { roles: ['auraplex-admin'] },
      'unrelated-client': { roles: ['unrelated-admin'] },
    },
  };
  assert.deepEqual(extractKeycloakGroups(profile), ['/auraplex-uploader']);
  assert.deepEqual(extractKeycloakGroups({ realm_access: { roles: ['auraplex-admin'] }, resource_access: profile.resource_access }), []);
});

test('double-submit CSRF requires matching header and cookie', () => {
  const valid = new Request('http://localhost/api/admin/uploads', {
    headers: {
      cookie: `${ADMIN_CSRF_COOKIE}=token-1`,
      'x-csrf-token': 'token-1',
    },
  });
  assert.doesNotThrow(() => doubleSubmitCsrfValidator.verify(valid));

  const invalid = new Request('http://localhost/api/admin/uploads', {
    headers: {
      cookie: `${ADMIN_CSRF_COOKIE}=token-1`,
      'x-csrf-token': 'token-2',
    },
  });
  assert.throws(() => doubleSubmitCsrfValidator.verify(invalid), (error: unknown) => {
    assert.ok(error instanceof UploadContractError);
    assert.equal(error.status, 403);
    return true;
  });
});

test('CSRF cookie is HttpOnly, production-secure, strict and API-scoped', () => {
  assert.deepEqual(adminCsrfCookieOptions(true), {
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
    path: ADMIN_CSRF_COOKIE_PATH,
    maxAge: 3_600,
  });
  assert.equal(ADMIN_CSRF_COOKIE_PATH, '/api/admin');
});

test('in-memory limiter enforces minute, hour and byte boundaries', () => {
  const perMinute = new InMemoryUploadRateLimiter();
  const now = Date.now();
  for (let index = 0; index < UPLOAD_RATE_LIMITS.uploadsPerMinute; index += 1) {
    perMinute.consume('minute-user', 1, now);
  }
  assert.throws(() => perMinute.consume('minute-user', 1, now), UploadContractError);

  const perHour = new InMemoryUploadRateLimiter();
  const hourStart = now - 3_599_999;
  for (let index = 0; index < UPLOAD_RATE_LIMITS.uploadsPerHour; index += 1) {
    perHour.consume('hour-user', 1, hourStart + index * 17_999);
  }
  assert.throws(() => perHour.consume('hour-user', 1, now), UploadContractError);

  const bytes = new InMemoryUploadRateLimiter();
  bytes.consume('byte-user', UPLOAD_RATE_LIMITS.bytesPerHour, now);
  assert.throws(() => bytes.consume('byte-user', 1, now), UploadContractError);
});

test('in-memory limiter garbage-collects expired users on later traffic', () => {
  const limiter = new InMemoryUploadRateLimiter();
  const tracked = (limiter as unknown as { events: Map<string, unknown> }).events;
  limiter.consume('inactive-user', 1, 1_000_000);
  assert.equal(tracked.has('inactive-user'), true);
  limiter.consume('active-user', 1, 1_000_000 + 3_600_001);
  assert.equal(tracked.has('inactive-user'), false);
  assert.equal(tracked.has('active-user'), true);
});

test('audit logger emits only the allowlisted event fields', () => {
  const messages: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => { messages.push(String(message)); };
  try {
    jsonAuditLogger.write({
      user: 'user-1',
      action: 'upload.accepted',
      key: 'labelling/product/manual.pdf',
      size: 10,
      ip: '127.0.0.1',
      timestamp: '2026-09-21T10:00:00.000Z',
    });
  } finally {
    console.info = original;
  }
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /secret|token|cookie|authorization/i);
  assert.deepEqual(Object.keys(JSON.parse(messages[0])).sort(), [
    'action', 'ip', 'key', 'size', 'timestamp', 'type', 'user',
  ]);
});

test('proxy IP parsing accepts only valid first-hop addresses', () => {
  assert.equal(requestIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7');
  assert.equal(requestIp(new Headers({ 'x-forwarded-for': 'spoofed', 'x-real-ip': '192.0.2.4' })), '192.0.2.4');
  assert.equal(requestIp(new Headers({ 'x-forwarded-for': 'spoofed' })), 'unknown');
});

test('Cloudflare IP is accepted only with a trusted ingress proof', () => {
  const previous = process.env.ADMIN_TRUSTED_PROXY_SECRET;
  process.env.ADMIN_TRUSTED_PROXY_SECRET = 'test-only-proxy-secret';
  try {
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.21',
      'x-forwarded-for': '192.0.2.14',
    });
    assert.equal(requestIp(headers), '192.0.2.14');
    headers.set('x-auraplex-proxy-secret', 'wrong');
    assert.equal(requestIp(headers), '192.0.2.14');
    headers.set('x-auraplex-proxy-secret', 'test-only-proxy-secret');
    assert.equal(requestIp(headers), '203.0.113.21');
    headers.set('cf-connecting-ip', 'not-an-ip');
    assert.equal(requestIp(headers), '192.0.2.14');
  } finally {
    if (previous === undefined) delete process.env.ADMIN_TRUSTED_PROXY_SECRET;
    else process.env.ADMIN_TRUSTED_PROXY_SECRET = previous;
  }
});

test('missing runtime integration configuration fails in a controlled way', () => {
  assert.throws(
    () => getMinioConfig({} as NodeJS.ProcessEnv),
    (error: unknown) => {
      assert.ok(error instanceof UploadContractError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'BACKEND_NOT_CONFIGURED');
      return true;
    },
  );
});

test('proxy includes admin page and direct API paths', () => {
  for (const path of ['/admin', '/admin/upload', '/api/admin/csrf', '/api/admin/uploads']) {
    assert.equal(isProtectedAdminPath(path), true);
  }
  assert.equal(isProtectedAdminPath('/en'), false);
  assert.equal(adminGuardStatus(undefined), 401);
  assert.equal(adminGuardStatus(['Viewer']), 403);
  assert.equal(adminGuardStatus(['auraplex-uploader']), 200);
  assert.equal(adminGuardStatus(['auraplex-admin']), 200);
});

test('CSRF handler independently rejects missing or unauthorized groups', async () => {
  const unauthenticated = await getAdminCsrfResponse(async () => { throw new UploadContractError(401, 'UNAUTHENTICATED', 'Authentication is required'); });
  const forbidden = await getAdminCsrfResponse(async () => ({ userId: 'viewer', groups: ['Viewer'] }));
  assert.equal(unauthenticated.status, 401);
  assert.equal(forbidden.status, 403);
  const allowed = await getAdminCsrfResponse(async () => ({ userId: 'uploader', groups: ['auraplex-uploader'] }));
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers.get('set-cookie') ?? '', /HttpOnly/i);
});

test('Auth.js cookies are explicitly HttpOnly and production secure', () => {
  const prod = authCookieConfig(true);
  const local = authCookieConfig(false);
  for (const cookie of Object.values(prod)) {
    assert.equal(cookie.options.httpOnly, true);
    assert.equal(cookie.options.sameSite, 'lax');
    assert.equal(cookie.options.path, '/');
    assert.equal(cookie.options.secure, true);
  }
  assert.equal(prod.sessionToken.name, '__Host-authjs.session-token');
  assert.equal(prod.csrfToken.name, '__Host-authjs.csrf-token');
  assert.equal(prod.pkceCodeVerifier.name.startsWith('__Secure-'), true);
  assert.equal(local.sessionToken.options.secure, false);
});

test('Keycloak logout URL uses discovery endpoint and server-held ID token hint', () => {
  const url = new URL(buildKeycloakLogoutUrl({
    issuer: 'https://sso.example.test/realms/auraplex',
    clientId: 'website',
    idToken: 'server-only-token',
    endpoint: 'https://sso.example.test/realms/auraplex/protocol/openid-connect/logout',
    postLogoutRedirectUri: 'https://site.example.test/en',
  }));
  assert.equal(url.searchParams.get('id_token_hint'), 'server-only-token');
  assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'https://site.example.test/en');
  assert.throws(() => buildKeycloakLogoutUrl({
    issuer: 'https://sso.example.test/realms/auraplex',
    clientId: 'website', idToken: 'x',
    endpoint: 'https://evil.example.test/logout',
    postLogoutRedirectUri: 'https://site.example.test/en',
  }));
});

test('Keycloak logout discovers the endpoint instead of hardcoding it', async () => {
  let requested = '';
  const fetcher = async (url: string | URL | Request) => {
    requested = String(url);
    return Response.json({
      issuer: 'https://sso.example.test/realms/auraplex',
      end_session_endpoint: 'https://sso.example.test/realms/auraplex/protocol/openid-connect/logout',
    });
  };
  const url = new URL(await discoverKeycloakLogoutUrl(
    'server-held-token',
    fetcher as typeof fetch,
    { issuer: 'https://sso.example.test/realms/auraplex', clientId: 'website', clientSecret: 'test-only' },
    'https://site.example.test',
  ));
  assert.equal(requested, 'https://sso.example.test/realms/auraplex/.well-known/openid-configuration');
  assert.equal(url.searchParams.get('id_token_hint'), 'server-held-token');
  assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'https://site.example.test/en');
});

test('Keycloak discovery failure falls back to local-only logout destination', async () => {
  assert.equal(await tryDiscoverKeycloakLogoutUrl(undefined), null);
  assert.equal(await tryDiscoverKeycloakLogoutUrl('token', async () => { throw new Error('offline'); }), null);
  assert.equal(await tryDiscoverKeycloakLogoutUrl('token', async () => 'https://sso.example.test/logout'), 'https://sso.example.test/logout');
});
