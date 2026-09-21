import NextAuth from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';
import { extractKeycloakRoles } from '@/lib/admin/server/authorization';
import { tryGetKeycloakConfig } from '@/lib/admin/server/config';

let keycloak: ReturnType<typeof tryGetKeycloakConfig> = null;
try {
  keycloak = tryGetKeycloakConfig();
} catch {
  // The admin API reports partial configuration as a controlled 503 before it
  // invokes Auth.js. Keeping bootstrap inert also lets local builds run safely.
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET || undefined,
  trustHost: true,
  providers: keycloak
    ? [
        Keycloak({
          issuer: keycloak.issuer,
          clientId: keycloak.clientId,
          clientSecret: keycloak.clientSecret,
        }),
      ]
    : [],
  callbacks: {
    jwt({ token, profile }) {
      if (profile) token.roles = extractKeycloakRoles(profile);
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        const user = session.user as typeof session.user & {
          id?: string;
          roles?: string[];
        };
        if (token.sub) user.id = token.sub;
        user.roles = Array.isArray(token.roles)
          ? token.roles.filter((role): role is string => typeof role === 'string')
          : [];
      }
      return session;
    },
  },
});
