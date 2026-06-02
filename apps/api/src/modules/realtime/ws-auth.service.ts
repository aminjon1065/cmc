import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import { REALTIME_SUBPROTOCOL, type JwtClaims } from "@cmc/contracts";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../../config/configuration";
import { TenantDatabaseService } from "../database/tenant-database.service";

/** The authenticated principal behind a realtime socket. */
export type WsPrincipal = {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  email: string;
  sessionId: string;
};

/** Raised for any failure to authenticate a WS upgrade (token/session). */
export class WsAuthError extends Error {}

/**
 * Authenticates a WebSocket upgrade the same way `TenantContextMiddleware`
 * authenticates an HTTP request: verify the access JWT (HS256 + issuer pinned)
 * and confirm the referenced session is still active in the DB. The token is
 * presented via the `cmc-bearer` subprotocol (preferred) or an `?access_token=`
 * query param (fallback). No tenant transaction is open on a raw upgrade, so the
 * session check runs privileged — exactly like the middleware's pre-context path.
 */
@Injectable()
export class WsAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly tenantDb: TenantDatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async authenticate(req: IncomingMessage): Promise<WsPrincipal> {
    const token = this.extractToken(req);
    if (!token) throw new WsAuthError("missing access token");

    let claims: JwtClaims;
    try {
      claims = await this.jwt.verifyAsync<JwtClaims>(token, {
        algorithms: ["HS256"],
        issuer: this.config.get("JWT_ISSUER", { infer: true }),
      });
    } catch (err) {
      throw new WsAuthError(
        `invalid token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!claims.sid) throw new WsAuthError("token missing session id");

    const active = await this.isSessionActive(claims);
    if (!active) throw new WsAuthError("session not active");

    return {
      userId: claims.sub,
      tenantId: claims.tid,
      tenantSlug: claims.ts,
      email: claims.email,
      sessionId: claims.sid,
    };
  }

  /** Token from the `cmc-bearer` subprotocol, else the `access_token` query. */
  private extractToken(req: IncomingMessage): string | null {
    const proto = req.headers["sec-websocket-protocol"];
    if (proto) {
      const parts = (Array.isArray(proto) ? proto.join(",") : proto)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const idx = parts.indexOf(REALTIME_SUBPROTOCOL);
      if (idx >= 0) {
        const candidate = parts[idx + 1];
        if (candidate) return candidate;
      }
    }
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      return (
        url.searchParams.get("access_token") ?? url.searchParams.get("token")
      );
    } catch {
      return null;
    }
  }

  private async isSessionActive(claims: JwtClaims): Promise<boolean> {
    return this.tenantDb.runPrivileged(async (tx) => {
      const rows = await tx
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, claims.sid),
            eq(schema.sessions.userId, claims.sub),
            eq(schema.sessions.tenantId, claims.tid),
            isNull(schema.sessions.revokedAt),
            sql`${schema.sessions.expiresAt} > now()`,
          ),
        )
        .limit(1);
      return rows.length > 0;
    });
  }
}
