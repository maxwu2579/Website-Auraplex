import type { Session } from 'next-auth';
import { UploadContractError } from '@/lib/admin/upload-errors';
import { getKeycloakConfig } from '@/lib/admin/server/config';

export interface AdminIdentity {
  userId: string;
  email?: string;
  roles: string[];
}

export interface AdminRoleMapping {
  uploader: string;
  admin: string;
}

export function getAdminRoleMapping(
  env: NodeJS.ProcessEnv = process.env,
): AdminRoleMapping {
  return {
    uploader: env.KEYCLOAK_UPLOADER_ROLE?.trim() || 'Uploader',
    admin: env.KEYCLOAK_ADMIN_ROLE?.trim() || 'Admin',
  };
}

function normalizedRole(role: string): string {
  return role.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
}

export function canUpload(
  identity: AdminIdentity,
  mapping: AdminRoleMapping = getAdminRoleMapping(),
): boolean {
  const allowed = new Set([
    normalizedRole(mapping.uploader),
    normalizedRole(mapping.admin),
  ]);
  return identity.roles.some((role) => allowed.has(normalizedRole(role)));
}

export function canViewAllUploads(
  identity: AdminIdentity,
  mapping: AdminRoleMapping = getAdminRoleMapping(),
): boolean {
  const adminRole = normalizedRole(mapping.admin);
  return identity.roles.some((role) => normalizedRole(role) === adminRole);
}

export function requireUploadPermission(
  identity: AdminIdentity | null,
  mapping?: AdminRoleMapping,
): AdminIdentity {
  if (!identity) {
    throw new UploadContractError(401, 'UNAUTHENTICATED', 'Authentication is required');
  }
  if (!canUpload(identity, mapping)) {
    throw new UploadContractError(403, 'FORBIDDEN', 'Uploader or Admin permission is required');
  }
  return identity;
}

export function identityFromSession(session: Session | null): AdminIdentity | null {
  if (!session?.user) return null;
  const user = session.user as Session['user'] & { id?: string; roles?: string[] };
  const userId = user.id || user.email || user.name;
  if (!userId) return null;
  return {
    userId,
    email: user.email ?? undefined,
    roles: Array.isArray(user.roles) ? user.roles : [],
  };
}

export async function authenticateAdminRequest(): Promise<AdminIdentity> {
  // Fail clearly before invoking Auth.js when local/production Keycloak values
  // are absent. This avoids pretending that SSO has been verified.
  getKeycloakConfig();
  const { auth } = await import('@/auth');
  return requireUploadPermission(identityFromSession(await auth()));
}

export function extractKeycloakRoles(
  profile: unknown,
  clientId?: string,
): string[] {
  if (!profile || typeof profile !== 'object') return [];
  const value = profile as {
    groups?: unknown;
    realm_access?: { roles?: unknown };
    resource_access?: Record<string, { roles?: unknown }>;
  };
  const groups = Array.isArray(value.groups)
    ? value.groups.filter((item): item is string => typeof item === 'string')
    : [];
  const roles = Array.isArray(value.realm_access?.roles)
    ? value.realm_access.roles.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const clientRoles = clientId && Array.isArray(value.resource_access?.[clientId]?.roles)
    ? value.resource_access[clientId].roles.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  return Array.from(new Set([...groups, ...roles, ...clientRoles]));
}
