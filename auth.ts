import NextAuth from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';
import { extractKeycloakGroups } from '@/lib/admin/server/authorization';
import { tryGetKeycloakConfig } from '@/lib/admin/server/config';
import { authCookieConfig } from '@/lib/admin/server/auth-cookies';

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
  session: { strategy: 'jwt' },
  cookies: authCookieConfig(process.env.NODE_ENV === 'production'),
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
    jwt({ token, profile, account }) {
      // Auth.js passes validated ID-token claims as profile for OIDC providers.
      // Keep the raw ID token only in the encrypted, HttpOnly server JWT for RP logout.
      if (profile) token.groups = extractKeycloakGroups(profile);
      if (account?.id_token) token.idToken = account.id_token;
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        const user = session.user as typeof session.user & {
          id?: string;
          groups?: string[];
        };
        if (token.sub) user.id = token.sub;
        user.groups = Array.isArray(token.groups)
          ? token.groups.filter((group): group is string => typeof group === 'string')
          : [];
      }
      return session;
    },
  },
});
