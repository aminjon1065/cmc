import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { Request, Response, NextFunction } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { JwtClaims } from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import {
  TenantContextService,
  type TenantContext,
} from "./tenant-context.service";
import { TenantDatabaseService } from "../../modules/database/tenant-database.service";
import { SessionCacheService } from "../session-cache/session-cache.service";

/**
 * Validates the Authorization Bearer JWT (if present), confirms the
 * referenced session is still active in the database, and:
 *   1. attaches the resolved tenant/user/session to `req.tenantContext`,
 *   2. wraps the rest of the handler chain inside an ALS scope so
 *      downstream services can read the same context implicitly.
 *
 * Anonymous requests (no header / invalid token / revoked session) pass
 * through with no context — protected routes are rejected later by
 * `JwtAuthGuard`. The session-validity check uses `runPrivileged` because
 * we need to look up the session BEFORE we know which tenant transaction
 * to open (and the transaction interceptor needs the context to do that).
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly tenantContext: TenantContextService,
    private readonly tenantDb: TenantDatabaseService,
    private readonly sessionCache: SessionCacheService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const header = req.headers.authorization;

    if (!header?.startsWith("Bearer ")) {
      return next();
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) return next();

    let claims: JwtClaims;
    try {
      // Pin algorithm + issuer so a future use of JWT_SECRET for any other
      // token type (e.g. signup invite, share link) is not silently accepted
      // as an access token.
      claims = this.jwt.verify<JwtClaims>(token, {
        algorithms: ["HS256"],
        issuer: this.config.get("JWT_ISSUER", { infer: true }),
      });
    } catch (err) {
      this.logger.debug(
        `Discarding invalid bearer token on ${req.method} ${req.url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return next();
    }

    if (!claims.sid) {
      // Tokens issued by previous deployments without `sid` are not
      // honoured under the new scheme.
      return next();
    }

    // Confirm the session is still active. Hot path — we check Redis
    // first (P0.4 / ADR-0011). The cache stores `{ userId, tenantId }`
    // for each active sid; a hit whose payload matches the JWT claims
    // bypasses the DB. Misses, payload mismatches, and cache errors all
    // fall through to the canonical DB query — which is the source of
    // truth — and populate the cache on success.
    //
    // Privileged tx because we have no tenant scope set up yet — and the
    // request interceptor expects the context already populated.
    let sessionActive = false;
    const cached = await this.sessionCache.get(claims.sid);
    if (
      cached &&
      cached.userId === claims.sub &&
      cached.tenantId === claims.tid
    ) {
      sessionActive = true;
    } else {
      try {
        sessionActive = await this.tenantDb.runPrivileged(async (tx) => {
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
      } catch (err) {
        this.logger.error(
          `Session lookup failed; treating request as anonymous: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return next();
      }

      // Populate the cache after a DB-confirmed active session. Cache
      // failures are non-fatal — the service swallows them and logs.
      if (sessionActive) {
        const ttl = this.config.get("SESSION_CACHE_TTL_SEC", { infer: true });
        await this.sessionCache.set(
          claims.sid,
          { userId: claims.sub, tenantId: claims.tid },
          ttl,
        );
      }
    }

    if (!sessionActive) {
      this.logger.debug(
        `Session ${claims.sid} not active; treating request as anonymous`,
      );
      return next();
    }

    const context: TenantContext = {
      userId: claims.sub,
      tenantId: claims.tid,
      tenantSlug: claims.ts,
      sessionId: claims.sid,
      email: claims.email,
    };

    req.tenantContext = context;
    this.tenantContext.run(context, () => next());
  }
}
