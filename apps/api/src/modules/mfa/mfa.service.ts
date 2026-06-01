import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { authenticator } from "otplib";
import { toDataURL } from "qrcode";

// Accept a TOTP token within ±1 time step (±30s) of clock skew.
authenticator.options = { window: 1 };

/** otplib verify → boolean, tolerant of malformed tokens. */
function verifyTotp(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { MfaEnrolResponse, MfaStatusResponse } from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { SecretBoxService } from "../../common/crypto/secret-box.service";
import { AuditService } from "../audit/audit.service";

type Tx = Parameters<Parameters<TenantDatabaseService["run"]>[0]>[0];

/**
 * TOTP multi-factor authentication (P1.2 / ADR-0020).
 *
 * Enrolment is confirm-before-active: `startEnrolment` stores an *unverified*
 * method; `confirmEnrolment` requires a valid first code before `verified_at`
 * is set and the factor starts gating login. Secrets are AES-256-GCM encrypted
 * at rest (SecretBoxService).
 *
 * The methods that need to run from the pre-auth login path
 * (`isMfaEnabledForUser`, `verifyForUser`, `consumeBackupCode`) take an
 * explicit `tx` so the caller controls the (privileged) transaction; the
 * authenticated management methods open their own tenant-scoped tx.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);
  private readonly issuer: string;
  private readonly backupCount: number;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly secretBox: SecretBoxService,
    private readonly audit: AuditService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.issuer = config.get("MFA_ISSUER", { infer: true });
    this.backupCount = config.get("MFA_BACKUP_CODE_COUNT", { infer: true });
  }

  // ---------- enrolment (authenticated) ----------

  /**
   * Begin TOTP enrolment for the current user: generate a secret, store it
   * encrypted + UNVERIFIED (replacing any prior unconfirmed method), and return
   * the otpauth URI + QR for the authenticator app.
   */
  async startEnrolment(
    userId: string,
    tenantId: string,
    accountLabel: string,
  ): Promise<MfaEnrolResponse> {
    const secret = authenticator.generateSecret();
    const encrypted = this.secretBox.encrypt(secret);

    await this.tenantDb.run(async (tx) => {
      // Replace any existing (verified or not) TOTP method — re-enrolling
      // starts fresh and invalidates old backup codes.
      await tx
        .delete(schema.userMfaMethods)
        .where(
          and(
            eq(schema.userMfaMethods.userId, userId),
            eq(schema.userMfaMethods.kind, "totp"),
          ),
        );
      await tx
        .delete(schema.mfaBackupCodes)
        .where(eq(schema.mfaBackupCodes.userId, userId));
      await tx.insert(schema.userMfaMethods).values({
        userId,
        tenantId,
        kind: "totp",
        secretEncrypted: encrypted,
        verifiedAt: null,
      });
    });

    const otpauthUri = authenticator.keyuri(accountLabel, this.issuer, secret);
    const qrDataUrl = await toDataURL(otpauthUri);

    await this.audit.record({
      tenantId,
      actorId: userId,
      actorType: "user",
      action: "mfa.enrol.started",
      resourceType: "user",
      resourceId: userId,
      outcome: "success",
    });

    return { secret, otpauthUri, qrDataUrl };
  }

  /**
   * Finish enrolment: verify the first code, set `verified_at`, and issue a
   * fresh set of one-time backup codes (returned plaintext ONCE). Returns null
   * if there's no pending method or the code is wrong.
   */
  async confirmEnrolment(
    userId: string,
    tenantId: string,
    code: string,
  ): Promise<string[] | null> {
    const method = await this.tenantDb.run((tx) =>
      this.loadTotpMethod(tx, userId),
    );
    if (!method) return null;

    const secret = this.secretBox.decrypt(method.secretEncrypted);
    if (!verifyTotp(code, secret)) return null;

    const backupCodes = this.generateBackupCodes();
    const hashes = await Promise.all(
      backupCodes.map((c) => argon2.hash(c, { type: argon2.argon2id })),
    );

    await this.tenantDb.run(async (tx) => {
      await tx
        .update(schema.userMfaMethods)
        .set({ verifiedAt: sql`now()`, lastUsedAt: sql`now()` })
        .where(eq(schema.userMfaMethods.id, method.id));
      // Replace any prior backup codes.
      await tx
        .delete(schema.mfaBackupCodes)
        .where(eq(schema.mfaBackupCodes.userId, userId));
      await tx.insert(schema.mfaBackupCodes).values(
        hashes.map((codeHash) => ({ userId, tenantId, codeHash })),
      );
    });

    await this.audit.record({
      tenantId,
      actorId: userId,
      actorType: "user",
      action: "mfa.enrol.confirmed",
      resourceType: "user",
      resourceId: userId,
      outcome: "success",
    });

    return backupCodes;
  }

  /** Regenerate backup codes (requires MFA already enabled). Plaintext once. */
  async regenerateBackupCodes(
    userId: string,
    tenantId: string,
  ): Promise<string[] | null> {
    const method = await this.tenantDb.run((tx) =>
      this.loadTotpMethod(tx, userId),
    );
    if (!method || !method.verifiedAt) return null;

    const backupCodes = this.generateBackupCodes();
    const hashes = await Promise.all(
      backupCodes.map((c) => argon2.hash(c, { type: argon2.argon2id })),
    );
    await this.tenantDb.run(async (tx) => {
      await tx
        .delete(schema.mfaBackupCodes)
        .where(eq(schema.mfaBackupCodes.userId, userId));
      await tx.insert(schema.mfaBackupCodes).values(
        hashes.map((codeHash) => ({ userId, tenantId, codeHash })),
      );
    });
    await this.audit.record({
      tenantId,
      actorId: userId,
      actorType: "user",
      action: "mfa.backup_codes.regenerated",
      resourceType: "user",
      resourceId: userId,
      outcome: "success",
    });
    return backupCodes;
  }

  /** Disable MFA for the user after a valid code. Returns false if not enabled
   *  or the code is wrong. */
  async disable(
    userId: string,
    tenantId: string,
    code: string,
  ): Promise<boolean> {
    const ok = await this.verifyForUserInScope(userId, code);
    if (!ok) return false;
    await this.tenantDb.run(async (tx) => {
      await tx
        .delete(schema.userMfaMethods)
        .where(eq(schema.userMfaMethods.userId, userId));
      await tx
        .delete(schema.mfaBackupCodes)
        .where(eq(schema.mfaBackupCodes.userId, userId));
    });
    await this.audit.record({
      tenantId,
      actorId: userId,
      actorType: "user",
      action: "mfa.disabled",
      resourceType: "user",
      resourceId: userId,
      outcome: "success",
    });
    return true;
  }

  /** MFA status for the current user. */
  async status(userId: string): Promise<MfaStatusResponse> {
    return this.tenantDb.run(async (tx) => {
      const method = await this.loadTotpMethod(tx, userId);
      const remaining = method?.verifiedAt
        ? (
            await tx
              .select({ id: schema.mfaBackupCodes.id })
              .from(schema.mfaBackupCodes)
              .where(
                and(
                  eq(schema.mfaBackupCodes.userId, userId),
                  isNull(schema.mfaBackupCodes.usedAt),
                ),
              )
          ).length
        : 0;
      return {
        enabled: Boolean(method?.verifiedAt),
        pending: Boolean(method && !method.verifiedAt),
        backupCodesRemaining: remaining,
      };
    });
  }

  // ---------- login-path helpers (caller supplies the tx) ----------

  /** True iff the user has a VERIFIED TOTP factor. Runs in the caller's tx. */
  async isMfaEnabled(tx: Tx, userId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: schema.userMfaMethods.id })
      .from(schema.userMfaMethods)
      .where(
        and(
          eq(schema.userMfaMethods.userId, userId),
          eq(schema.userMfaMethods.kind, "totp"),
          isNotNull(schema.userMfaMethods.verifiedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Verify a TOTP code OR consume a backup code for the user, in the caller's
   * transaction (used by the login second step, which runs privileged).
   */
  async verifyForUser(
    tx: Tx,
    userId: string,
    code: string,
  ): Promise<boolean> {
    const method = await this.loadTotpMethod(tx, userId);
    if (!method || !method.verifiedAt) return false;

    const secret = this.secretBox.decrypt(method.secretEncrypted);
    if (verifyTotp(code, secret)) {
      await tx
        .update(schema.userMfaMethods)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(schema.userMfaMethods.id, method.id));
      return true;
    }

    // Fall back to a one-time backup code.
    return this.consumeBackupCode(tx, userId, code);
  }

  // ---------- internals ----------

  /** Verify in a self-opened tenant tx (for the authenticated disable path). */
  private async verifyForUserInScope(
    userId: string,
    code: string,
  ): Promise<boolean> {
    return this.tenantDb.run((tx) => this.verifyForUser(tx, userId, code));
  }

  private async loadTotpMethod(tx: Tx, userId: string) {
    const rows = await tx
      .select()
      .from(schema.userMfaMethods)
      .where(
        and(
          eq(schema.userMfaMethods.userId, userId),
          eq(schema.userMfaMethods.kind, "totp"),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Compare `code` against the user's unused backup codes; mark used on hit. */
  private async consumeBackupCode(
    tx: Tx,
    userId: string,
    code: string,
  ): Promise<boolean> {
    const codes = await tx
      .select()
      .from(schema.mfaBackupCodes)
      .where(
        and(
          eq(schema.mfaBackupCodes.userId, userId),
          isNull(schema.mfaBackupCodes.usedAt),
        ),
      );
    for (const row of codes) {
      if (await argon2.verify(row.codeHash, code)) {
        await tx
          .update(schema.mfaBackupCodes)
          .set({ usedAt: sql`now()` })
          .where(eq(schema.mfaBackupCodes.id, row.id));
        return true;
      }
    }
    return false;
  }

  private generateBackupCodes(): string[] {
    // 10 hex chars, grouped as xxxxx-xxxxx for readability.
    return Array.from({ length: this.backupCount }, () => {
      const raw = randomBytes(5).toString("hex"); // 10 hex chars
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
  }
}
