import assert from 'node:assert/strict';
import test from 'node:test';
import { UploadContractError } from '../lib/admin/upload-errors';
import {
  canViewAllUploads,
  canUpload,
  extractKeycloakRoles,
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
    () => requireUploadPermission({ userId: 'viewer', roles: ['Viewer'] }),
    (error: unknown) => {
      assert.ok(error instanceof UploadContractError);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test('Uploader and Admin roles can upload with centralized mapping', () => {
  assert.equal(canUpload({ userId: 'uploader', roles: ['Uploader'] }), true);
  assert.equal(canUpload({ userId: 'admin', roles: ['/Admin'] }), true);
  assert.equal(canUpload({ userId: 'viewer', roles: ['Viewer'] }), false);
  assert.equal(canViewAllUploads({ userId: 'uploader', roles: ['Uploader'] }), false);
  assert.equal(canViewAllUploads({ userId: 'admin', roles: ['/Admin'] }), true);
});

test('Keycloak groups, realm roles and configured client roles are propagated', () => {
  const profile = {
    groups: ['/Uploader'],
    realm_access: { roles: ['realm-reader'] },
    resource_access: {
      'website-client': { roles: ['Admin'] },
      'unrelated-client': { roles: ['unrelated-admin'] },
    },
  };
  assert.deepEqual(
    extractKeycloakRoles(profile, 'website-client'),
    ['/Uploader', 'realm-reader', 'Admin'],
  );
  assert.deepEqual(
    extractKeycloakRoles(profile),
    ['/Uploader', 'realm-reader'],
  );
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
