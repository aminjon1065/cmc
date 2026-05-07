import NextAuth, { type DefaultSession } from "next-auth";
// Side-effect import: forces TS to resolve `next-auth/jwt` so the
// `declare module "next-auth/jwt"` augmentation below has a target module.
import "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { LoginResponseSchema, LoginRequestSchema } from "@cmc/contracts";

const API_BASE_URL =
  process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Strategy: the credentials provider POSTs to the NestJS API's `/auth/login`.
 * The API's signed JWT is captured into the Auth.js session token so server
 * components and Route Handlers can forward it as `Authorization: Bearer ...`
 * on every API call.
 *
 * Auth.js manages a SEPARATE session cookie (encrypted with `AUTH_SECRET`)
 * — the API JWT lives inside it, never in client-readable storage.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = LoginRequestSchema.safeParse(raw);
        if (!parsed.success) return null;

        const res = await fetch(`${API_BASE_URL}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
        });
        if (!res.ok) return null;

        const json = await res.json();
        const validated = LoginResponseSchema.safeParse(json);
        if (!validated.success) return null;

        const { user, accessToken, expiresAt } = validated.data;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          tenantId: user.tenantId,
          tenantSlug: user.tenantSlug,
          accessToken,
          accessTokenExpiresAt: expiresAt,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // First call after authorize() — copy custom fields into the JWT cookie.
      if (user) {
        token.id = user.id;
        token.tenantId = (user as { tenantId?: string }).tenantId;
        token.tenantSlug = (user as { tenantSlug?: string }).tenantSlug;
        token.accessToken = (user as { accessToken?: string }).accessToken;
        token.accessTokenExpiresAt = (
          user as { accessTokenExpiresAt?: string }
        ).accessTokenExpiresAt;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id as string;
      session.tenantId = token.tenantId as string | undefined;
      session.tenantSlug = token.tenantSlug as string | undefined;
      session.accessToken = token.accessToken as string | undefined;
      session.accessTokenExpiresAt = token.accessTokenExpiresAt as
        | string
        | undefined;
      return session;
    },
  },
});

/**
 * Module augmentation — type the custom fields we shove into the session/JWT.
 */
declare module "next-auth" {
  interface Session {
    accessToken?: string;
    accessTokenExpiresAt?: string;
    tenantId?: string;
    tenantSlug?: string;
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    accessToken?: string;
    accessTokenExpiresAt?: string;
    tenantId?: string;
    tenantSlug?: string;
  }
}
