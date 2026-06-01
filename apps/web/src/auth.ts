import NextAuth, { type DefaultSession } from "next-auth";
// Side-effect import: forces TS to resolve `next-auth/jwt` so the
// `declare module "next-auth/jwt"` augmentation below has a target module.
import "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import {
  LoginRequestSchema,
  LoginResponseSchema,
  RefreshResponseSchema,
} from "@cmc/contracts";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:3001";

// NextAuth talks to the API directly (not via apiFetch), so it carries its own
// copy of the `/v1` version prefix (ADR-0027). Keep in lockstep with
// `lib/api.ts`'s API_PREFIX.
const API_V1 = `${API_BASE_URL}/v1`;

/**
 * Refresh the API access token a little before it actually expires so we
 * never serve a request with a token that's about to die on the wire.
 * 60s of slack covers clock drift and a slow refresh round-trip.
 */
const REFRESH_EARLY_MS = 60_000;

type RefreshResult = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
} | null;

/**
 * In-flight refresh deduplication.
 *
 * NextAuth's `jwt` callback runs on every server-side session read. When a
 * page issues two parallel API calls near the refresh boundary, both
 * invocations would race to /auth/refresh — the API's replay detection
 * (single-use refresh tokens) would treat the second call as theft and
 * revoke the entire session family. Cache the in-flight promise keyed by
 * the presented refresh token so concurrent callers await the same rotation.
 */
const refreshInFlight = new Map<string, Promise<RefreshResult>>();

async function refreshApiToken(refreshToken: string): Promise<RefreshResult> {
  const cached = refreshInFlight.get(refreshToken);
  if (cached) return cached;

  const promise = (async (): Promise<RefreshResult> => {
    try {
      const res = await fetch(`${API_V1}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return null;
      const json = await res.json();
      const parsed = RefreshResponseSchema.safeParse(json);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    } finally {
      refreshInFlight.delete(refreshToken);
    }
  })();

  refreshInFlight.set(refreshToken, promise);
  return promise;
}

/**
 * Auth.js (NextAuth v5) configuration.
 *
 * The credentials provider POSTs to the API's `/auth/login`. The API's
 * short-lived access JWT + long-lived refresh token are captured into the
 * Auth.js session token so server components and Route Handlers can
 * forward them on every API call.
 *
 * The `jwt` callback runs on every server-side session read; if the
 * access token is within REFRESH_EARLY_MS of expiry, we transparently
 * call `/auth/refresh` and rotate. A failed refresh marks the session
 * as errored — the next protected request signs the user out.
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

        const res = await fetch(`${API_V1}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
        });
        if (!res.ok) return null;

        const json = await res.json();
        const validated = LoginResponseSchema.safeParse(json);
        if (!validated.success) return null;

        const data = validated.data;
        return {
          id: data.user.id,
          email: data.user.email,
          name: data.user.name,
          tenantId: data.user.tenantId,
          tenantSlug: data.user.tenantSlug,
          accessToken: data.accessToken,
          accessTokenExpiresAt: data.accessTokenExpiresAt,
          refreshToken: data.refreshToken,
          refreshTokenExpiresAt: data.refreshTokenExpiresAt,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // First call after authorize(): copy custom fields into the JWT cookie.
      if (user) {
        token.id = user.id;
        token.tenantId = (user as { tenantId?: string }).tenantId;
        token.tenantSlug = (user as { tenantSlug?: string }).tenantSlug;
        token.accessToken = (user as { accessToken?: string }).accessToken;
        token.accessTokenExpiresAt = (
          user as { accessTokenExpiresAt?: string }
        ).accessTokenExpiresAt;
        token.refreshToken = (user as { refreshToken?: string }).refreshToken;
        token.refreshTokenExpiresAt = (
          user as { refreshTokenExpiresAt?: string }
        ).refreshTokenExpiresAt;
        delete token.error;
        return token;
      }

      // Subsequent calls (every session read): refresh if the access
      // token is close to expiring.
      if (
        !token.accessToken ||
        !token.accessTokenExpiresAt ||
        !token.refreshToken
      ) {
        return token;
      }

      const accessExpMs = Date.parse(token.accessTokenExpiresAt);
      if (!Number.isFinite(accessExpMs)) {
        return token;
      }

      if (accessExpMs - Date.now() > REFRESH_EARLY_MS) {
        return token; // still fresh
      }

      const refreshed = await refreshApiToken(token.refreshToken);
      if (!refreshed) {
        // Refresh failed — leave the existing token in place and mark
        // the session errored. UI surfaces this via session.error.
        token.error = "RefreshFailed";
        return token;
      }

      token.accessToken = refreshed.accessToken;
      token.accessTokenExpiresAt = refreshed.accessTokenExpiresAt;
      token.refreshToken = refreshed.refreshToken;
      token.refreshTokenExpiresAt = refreshed.refreshTokenExpiresAt;
      delete token.error;
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
      session.error = token.error as string | undefined;
      return session;
    },
  },
  events: {
    // Revoke the server-side session when the cookie is cleared. The local
    // cookie is gone either way; we only ask the API to invalidate its half
    // of the credential so a copy of the (now-cleared) refresh token cannot
    // be used to mint new access tokens elsewhere.
    async signOut(message) {
      const token =
        "token" in message && message.token
          ? (message.token as { accessToken?: string })
          : null;
      if (!token?.accessToken) return;
      try {
        await fetch(`${API_V1}/auth/logout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            "Content-Type": "application/json",
          },
        });
      } catch {
        // Best-effort; the local sign-out has already proceeded.
      }
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
    error?: string;
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
    refreshToken?: string;
    refreshTokenExpiresAt?: string;
    tenantId?: string;
    tenantSlug?: string;
    error?: string;
  }
}
