import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request, Response, NextFunction } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { JwtClaims } from "@cmc/contracts";
import {
  TenantContextService,
  type TenantContext,
} from "./tenant-context.service";
import { TenantDatabaseService } from "../../modules/database/tenant-database.service";

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
      claims = this.jwt.verify<JwtClaims>(token);
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

    // Confirm the session is still active. Privileged tx because we have
    // no tenant scope set up yet — and the request interceptor expects
    // the context already populated.
    let sessionActive = false;
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
