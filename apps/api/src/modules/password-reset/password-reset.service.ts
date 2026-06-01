import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { AppConfig } from "../../config/configuration";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { AuditService } from "../audit/audit.service";
import { UsersService } from "../users/users.service";
import { SessionsService } from "../auth/sessions.service";
import { AuthService } from "../auth/auth.service";
import {
  PASSWORD_RESET_NOTIFIER,
  type PasswordResetNotifier,
} from "./password-reset.notifier";

/** Per-request attribution carried into audit rows. */
type RequestMeta = { ip?: string | null; userAgent?: string | null };

/**
 * Password-reset orchestration (P1.3 / ADR-0021).
 *
 * Tokens are random 256-bit secrets stored only as their sha256 hash — a DB
 * dump cannot be used to reset a password. A reset changes ONLY the password:
 * it revokes every session (forcing a fresh login) but leaves any MFA factor
 * intact, so the second factor is still required at the next login.
 *
 * Scope discipline:
 *   - Self-service (forgot / complete-by-token) has no tenant context, so it
 *     runs PRIVILEGED (RLS bypass) — the same pattern the login cross-tenant
 *     lookup uses.
 *   - Admin-initiated runs inside the admin's tenant transaction, so RLS
 *     confines the target lookup + token insert to the admin's own tenant.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly tenantDb: TenantDatabaseService,
    private readonly audit: AuditService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    @Inject(PASSWORD_RESET_NOTIFIER)
    private readonly notifier: PasswordResetNotifier,
  ) {}

  // ---------- token helpers ----------

  private hashToken(plain: string): string {
    return createHash("sha256").update(plain).digest("hex");
  }

  private mintToken(): { plain: string; hash: string } {
    const plain = randomBytes(32).toString("base64url");
    return { plain, hash: this.hashToken(plain) };
  }

  private buildResetUrl(token: string): string {
    const base = this.config.get("PASSWORD_RESET_URL_BASE", { infer: true });
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}token=${encodeURIComponent(token)}`;
  }

  /**
   * Create a fresh single-use token for a user, invalidating any prior unused
   * one (only one live token per user). Runs in whatever ambient scope the
   * caller established. Returns the PLAINTEXT token (never persisted) + expiry.
   */
  private async createToken(
    user: { id: string; tenantId: string },
    createdBy: string | null,
  ): Promise<{ token: string; expiresAt: Date }> {
    const ttlSec = this.config.get("PASSWORD_RESET_TTL_SEC", { infer: true });
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const { plain, hash } = this.mintToken();

    await this.tenantDb.run(async (tx) => {
      // One live token per user: burn any outstanding unused ones first.
      await tx
        .update(schema.passwordResets)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(schema.passwordResets.userId, user.id),
            isNull(schema.passwordResets.usedAt),
          ),
        );
      await tx.insert(schema.passwordResets).values({
        userId: user.id,
        tenantId: user.tenantId,
        tokenHash: hash,
        expiresAt,
        createdBy,
      });
    });

    return { token: plain, expiresAt };
  }

  // ---------- self-service ----------

  /**
   * Self-initiated "forgot password". ALWAYS resolves without revealing whether
   * the email exists (no account enumeration). When exactly one active user
   * matches, mints a token and hands it to the notifier (dev logs the link;
   * SMTP at P1.6). An ambiguous email (same address in two tenants) or no match
   * is a silent no-op.
   */
  async requestSelfReset(email: string, meta: RequestMeta): Promise<void> {
    await this.tenantDb.runPrivileged(async () => {
      const matches = await this.users.findActiveByEmailGlobal(email);
      if (matches.length !== 1) {
        // 0 → no such account; 2 → ambiguous across tenants. Either way we
        // can't safely act, and we must not leak the difference.
        this.logger.debug(
          `Forgot-password for "${email}": ${matches.length} active match(es); no-op`,
        );
        return;
      }
      const user = matches[0]!;
      const { token, expiresAt } = await this.createToken(user, null);

      await this.notifier.sendResetLink({
        email: user.email,
        name: user.name,
        token,
        resetUrl: this.buildResetUrl(token),
        expiresAt: expiresAt.toISOString(),
      });

      await this.audit.record({
        tenantId: user.tenantId,
        actorId: user.id,
        actorType: "user",
        action: "password.reset_requested",
        resourceType: "user",
        resourceId: user.id,
        outcome: "success",
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { channel: "self" },
      });
    });
  }

  // ---------- admin-initiated ----------

  /**
   * Admin-initiated reset. Runs inside the admin's tenant transaction so RLS
   * limits the target to the admin's own tenant. Returns the plaintext token
   * to the admin to relay out-of-band (no email needed). Gated upstream by the
   * `user:manage` permission.
   */
  async requestAdminReset(
    targetUserId: string,
    admin: { userId: string; tenantId: string },
    meta: RequestMeta,
  ): Promise<{ token: string; expiresAt: string }> {
    const target = await this.users.findById(targetUserId);
    if (!target) {
      // RLS already scoped the lookup to the admin's tenant; a miss means
      // "not in your tenant" or "doesn't exist" — surface the same 404.
      throw new NotFoundException("User not found");
    }

    const { token, expiresAt } = await this.createToken(
      { id: target.id, tenantId: target.tenantId },
      admin.userId,
    );

    await this.audit.record({
      tenantId: admin.tenantId,
      actorId: admin.userId,
      actorType: "user",
      action: "password.reset_requested",
      resourceType: "user",
      resourceId: target.id,
      outcome: "success",
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata: { channel: "admin" },
    });

    return { token, expiresAt: expiresAt.toISOString() };
  }

  // ---------- completion (shared) ----------

  /**
   * Complete a reset with a token. Public + unauthenticated, so it runs
   * privileged. Validates the token (exists, unused, unexpired), sets the new
   * password, single-use-consumes the token, and revokes ALL the user's
   * sessions. MFA is deliberately left untouched.
   */
  async completeReset(
    token: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const tokenHash = this.hashToken(token);

    // Cheap pre-check (no expensive hash on an obviously-bad token).
    const reset = await this.tenantDb.runPrivileged(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.passwordResets)
        .where(eq(schema.passwordResets.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    });

    const invalidReason = !reset
      ? "unknown_token"
      : reset.usedAt !== null
        ? "already_used"
        : reset.expiresAt.getTime() <= Date.now()
          ? "expired"
          : null;

    if (invalidReason) {
      await this.audit.record({
        tenantId: reset?.tenantId ?? null,
        actorId: reset?.userId ?? null,
        actorType: reset ? "user" : "anonymous",
        action: "password.reset_completed",
        resourceType: "user",
        resourceId: reset?.userId ?? null,
        outcome: "failure",
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { reason: invalidReason },
        durable: true,
      });
      // Generic message: don't disclose which of unknown/used/expired it was.
      throw new BadRequestException("Invalid or expired reset token");
    }

    // Hash OUTSIDE any transaction — argon2 is ~50ms; don't pin a connection.
    const passwordHash = await AuthService.hashPassword(newPassword);

    await this.tenantDb.runPrivileged(async (tx) => {
      // Atomic single-use consume: succeeds only if STILL unused + unexpired.
      // Wins the race against a concurrent completion of the same token.
      const consumed = await tx
        .update(schema.passwordResets)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(schema.passwordResets.id, reset!.id),
            isNull(schema.passwordResets.usedAt),
            sql`${schema.passwordResets.expiresAt} > now()`,
          ),
        )
        .returning({ id: schema.passwordResets.id });

      if (consumed.length === 0) {
        throw new BadRequestException("Invalid or expired reset token");
      }

      // Set the new password (reuses this privileged tx via ambient scope).
      await this.users.updatePassword(reset!.userId, passwordHash);

      // A reset forces a fresh login everywhere — kills any attacker session.
      // MFA factors are intentionally left intact (still required next login).
      await this.sessions.revokeAllForUser(reset!.userId, "password_reset");

      // Success audit, atomic with the change.
      await this.audit.record({
        tenantId: reset!.tenantId,
        actorId: reset!.userId,
        actorType: "user",
        action: "password.reset_completed",
        resourceType: "user",
        resourceId: reset!.userId,
        outcome: "success",
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { channel: reset!.createdBy ? "admin" : "self" },
      });
    });
  }
}
