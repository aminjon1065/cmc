import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, not, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import { TenantDatabaseService } from "../database/tenant-database.service";

export type CreateSessionInput = {
  tenantId: string;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  refreshTokenLifetimeSec: number;
  /** Optional. If provided, the new session inherits this family + parent. */
  parent?: {
    familyId: string;
    parentSessionId: string;
  };
};

export type RotateSessionResult =
  | {
      ok: true;
      session: typeof schema.sessions.$inferSelect;
      plainRefreshToken: string;
    }
  | { ok: false; reason: "not_found" | "expired" | "revoked" | "replay" };

export type RevokeReason =
  | "logout"
  | "rotation_replay"
  | "rotation_superseded"
  | "admin"
  | "expired";

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(private readonly tenantDb: TenantDatabaseService) {}

  // ---------- Token generation ----------

  /**
   * Mint a fresh refresh token (URL-safe random) and its server-side hash.
   * Only the hash is persisted; only the plain token is returned to the client.
   */
  static mintRefreshToken(): { plain: string; hash: string } {
    const plain = randomBytes(48).toString("base64url");
    const hash = SessionsService.hashRefreshToken(plain);
    return { plain, hash };
  }

  static hashRefreshToken(plain: string): string {
    return createHash("sha256").update(plain).digest("hex");
  }

  // ---------- CRUD ----------

  async create(input: CreateSessionInput): Promise<{
    session: typeof schema.sessions.$inferSelect;
    plainRefreshToken: string;
  }> {
    const { plain, hash } = SessionsService.mintRefreshToken();
    const familyId = input.parent?.familyId ?? crypto.randomUUID();
    const parentId = input.parent?.parentSessionId ?? null;
    const expiresAt = new Date(
      Date.now() + input.refreshTokenLifetimeSec * 1000,
    );

    const [row] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.sessions)
        .values({
          tenantId: input.tenantId,
          userId: input.userId,
          familyId,
          parentId,
          refreshTokenHash: hash,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          expiresAt,
        })
        .returning(),
    );
    return { session: row!, plainRefreshToken: plain };
  }

  async findByRefreshTokenHash(hash: string) {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.refreshTokenHash, hash))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async findById(id: string) {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Cheap "is this session still active" check used by the request
   * middleware. Returns null when the session is missing, revoked, or
   * past its absolute expiry — all of which translate to "401" upstream.
   */
  async findActiveById(id: string) {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, id),
            isNull(schema.sessions.revokedAt),
            // expires_at > now()
            sql`${schema.sessions.expiresAt} > now()`,
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async listActiveByUser(userId: string) {
    return this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.userId, userId),
            isNull(schema.sessions.revokedAt),
            sql`${schema.sessions.expiresAt} > now()`,
          ),
        )
        .orderBy(schema.sessions.lastUsedAt),
    );
  }

  async revoke(id: string, reason: RevokeReason): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.sessions)
        .set({ revokedAt: sql`now()`, revokedReason: reason })
        .where(
          and(eq(schema.sessions.id, id), isNull(schema.sessions.revokedAt)),
        ),
    );
  }

  async revokeFamily(familyId: string, reason: RevokeReason): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.sessions)
        .set({ revokedAt: sql`now()`, revokedReason: reason })
        .where(
          and(
            eq(schema.sessions.familyId, familyId),
            isNull(schema.sessions.revokedAt),
          ),
        ),
    );
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.sessions)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(schema.sessions.id, id)),
    );
  }

  // ---------- Rotation with replay detection ----------

  /**
   * Atomically rotate a refresh token: validate the presented one, mark it
   * superseded, and produce a successor session in the same family.
   *
   * Replay detection: if the presented token belongs to a session that has
   * already been revoked (rotated past), we revoke the entire family —
   * a refresh token is single-use, so seeing the same one twice is a
   * theft signal.
   */
  async rotate(
    presentedRefreshToken: string,
    refreshTokenLifetimeSec: number,
    ip: string | null,
    userAgent: string | null,
  ): Promise<RotateSessionResult> {
    const hash = SessionsService.hashRefreshToken(presentedRefreshToken);

    return this.tenantDb.run(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.refreshTokenHash, hash))
        .limit(1);
      const session = rows[0];

      if (!session) {
        return { ok: false as const, reason: "not_found" as const };
      }

      // Replay: this token's row was already revoked. Burn the family.
      // The burn MUST be durable even if the calling request errors out
      // (e.g., the controller throws 401 right after this returns) — so
      // we do it in an autonomous transaction (`runPrivileged` opens a
      // fresh connection) instead of the caller's tx.
      if (session.revokedAt) {
        const familyId = session.familyId;
        await this.tenantDb.runPrivileged(async (privTx) => {
          await privTx
            .update(schema.sessions)
            .set({
              revokedAt: sql`now()`,
              revokedReason: "rotation_replay",
            })
            .where(
              and(
                eq(schema.sessions.familyId, familyId),
                isNull(schema.sessions.revokedAt),
              ),
            );
        });
        this.logger.warn(
          `Refresh-token replay detected; revoked family ${session.familyId}`,
        );
        return { ok: false as const, reason: "replay" as const };
      }

      if (session.expiresAt.getTime() <= Date.now()) {
        return { ok: false as const, reason: "expired" as const };
      }

      // Mint successor.
      const { plain, hash: newHash } = SessionsService.mintRefreshToken();
      const newExpires = new Date(Date.now() + refreshTokenLifetimeSec * 1000);

      const [successor] = await tx
        .insert(schema.sessions)
        .values({
          tenantId: session.tenantId,
          userId: session.userId,
          familyId: session.familyId,
          parentId: session.id,
          refreshTokenHash: newHash,
          ip: ip ?? session.ip,
          userAgent: userAgent ?? session.userAgent,
          expiresAt: newExpires,
        })
        .returning();

      // Mark the old row superseded.
      await tx
        .update(schema.sessions)
        .set({
          revokedAt: sql`now()`,
          revokedReason: "rotation_superseded",
        })
        .where(eq(schema.sessions.id, session.id));

      return {
        ok: true as const,
        session: successor!,
        plainRefreshToken: plain,
      };
    });
  }

  /**
   * Sweep expired sessions. Run from a scheduled job (not yet wired);
   * exposed here so callers can also trigger on-demand cleanups in tests.
   */
  async revokeExpired(): Promise<number> {
    const res = await this.tenantDb.run((tx) =>
      tx
        .update(schema.sessions)
        .set({ revokedAt: sql`now()`, revokedReason: "expired" })
        .where(
          and(
            isNull(schema.sessions.revokedAt),
            lt(schema.sessions.expiresAt, sql`now()`),
            // sanity: don't double-revoke
            not(eq(schema.sessions.revokedReason, "expired")),
          ),
        )
        .returning({ id: schema.sessions.id }),
    );
    return res.length;
  }
}
