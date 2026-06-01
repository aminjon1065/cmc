import { createHash } from "node:crypto";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Redis } from "ioredis";
import { authenticator } from "otplib";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenant,
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
  type TestTenant,
  type TestUser,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";
import { PASSWORD_RESET_NOTIFIER } from "../../src/modules/password-reset/password-reset.notifier";
import type {
  PasswordResetMessage,
  PasswordResetNotifier,
} from "../../src/modules/password-reset/password-reset.notifier";

/** Test double that captures the token the service would have delivered. */
class CapturingNotifier implements PasswordResetNotifier {
  public messages: PasswordResetMessage[] = [];
  async sendResetLink(message: PasswordResetMessage): Promise<void> {
    this.messages.push(message);
  }
  get last(): PasswordResetMessage | undefined {
    return this.messages[this.messages.length - 1];
  }
  reset(): void {
    this.messages = [];
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Password reset (P1.3 / ADR-0021).
 *
 * Self-service (forgot → token → reset) and admin-initiated (returns the
 * token) share one single-use, hashed token. A reset changes ONLY the
 * password: it revokes the user's sessions but leaves MFA intact.
 */
describe("Password reset", () => {
  let app: NestExpressApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  const notifier = new CapturingNotifier();

  let tenant: TestTenant;
  let admin: TestUser;
  let target: TestUser;

  beforeAll(async () => {
    app = await buildTestApp((b) =>
      b.overrideProvider(PASSWORD_RESET_NOTIFIER).useValue(notifier),
    );
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await truncateAll(sql, redis);
    notifier.reset();
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "pwreset-tenant",
      email: "admin@pwreset.test",
      password: "admin_pwd_123456",
    });
    tenant = fixture.tenant;
    admin = fixture.user;
    target = await createUser(sql, tenant, {
      email: "target@pwreset.test",
      password: "old_password_123",
    });
  });

  /** Count the password_resets rows for a user. */
  async function resetRows(userId: string) {
    return sql<
      {
        id: string;
        token_hash: string;
        used_at: Date | null;
        created_by: string | null;
        expires_at: Date;
      }[]
    >`SELECT id, token_hash, used_at, created_by, expires_at
        FROM password_resets WHERE user_id = ${userId}`;
  }

  // ---------- self-service request ----------

  it("forgot returns 204 and mints a single-use, hashed, self-channel token", async () => {
    await request(app.getHttpServer())
      .post("/v1/auth/password/forgot")
      .send({ email: target.email })
      .expect(204);

    // The notifier got the token; the DB stored only its hash.
    expect(notifier.last?.email).toBe(target.email);
    const token = notifier.last!.token;
    const rows = await resetRows(target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(sha256(token));
    expect(rows[0]!.used_at).toBeNull();
    expect(rows[0]!.created_by).toBeNull(); // self-initiated
    expect(rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("forgot for an unknown email is 204 but mints nothing (no enumeration)", async () => {
    await request(app.getHttpServer())
      .post("/v1/auth/password/forgot")
      .send({ email: "ghost@pwreset.test" })
      .expect(204);

    expect(notifier.messages).toHaveLength(0);
    const all = await sql`SELECT count(*)::int AS n FROM password_resets`;
    expect(all[0]!.n).toBe(0);
  });

  // ---------- completion ----------

  it("a self-service token resets the password: old fails, new works", async () => {
    await request(app.getHttpServer())
      .post("/v1/auth/password/forgot")
      .send({ email: target.email })
      .expect(204);
    const token = notifier.last!.token;

    await request(app.getHttpServer())
      .post("/v1/auth/password/reset")
      .send({ token, newPassword: "brand_new_pw_456" })
      .expect(204);

    // Old credentials are dead.
    await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: target.email, password: target.password })
      .expect(401);
    // New credentials work.
    const ok = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: target.email, password: "brand_new_pw_456" })
      .expect(200);
    expect(ok.body.status).toBe("ok");
  });

  it("a reset token is single-use", async () => {
    await request(app.getHttpServer())
      .post("/v1/auth/password/forgot")
      .send({ email: target.email })
      .expect(204);
    const token = notifier.last!.token;

    await request(app.getHttpServer())
      .post("/v1/auth/password/reset")
      .send({ token, newPassword: "first_new_pw_789" })
      .expect(204);
    // Replaying the same token is rejected.
    await request(app.getHttpServer())
      .post("/v1/auth/password/reset")
      .send({ token, newPassword: "second_new_pw_000" })
      .expect(400);
  });

  it("an expired token is rejected", async () => {
    await request(app.getHttpServer())
      .post("/v1/auth/password/forgot")
      .send({ email: target.email })
      .expect(204);
    const token = notifier.last!.token;

    // Backdate the expiry past now.
    await sql`UPDATE password_resets SET expires_at = now() - interval '1 minute'
              WHERE user_id = ${target.id}`;

    await request(app.getHttpServer())
      .post("/v1/auth/password/reset")
      .send({ token, newPassword: "should_not_apply_1" })
      .expect(400);
    // Password unchanged: original still works.
    await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: target.email, password: target.password })
      .expect(200);
  });

  it("an unknown token is rejected", async () => {
    await request(app.getHttpServer())
      .post("/v1/auth/password/reset")
      .send({ token: "definitely-not-a-real-token-0001", newPassword: "whatever_pw_1" })
      .expect(400);
  });

  it("completing a reset revokes the user's existing sessions", async () => {
    // An active session for the target.
    const session = await loginAs(app, target);
    await authed(app, session.accessToken).get("/v1/auth/me").expect(200);

    await request(app.getHttpServer())
      .post("/v1/auth/password/forgot")
      .send({ email: target.email })
      .expect(204);
    const token = notifier.last!.token;
    await request(app.getHttpServer())
      .post("/v1/auth/password/reset")
      .send({ token, newPassword: "after_reset_pw_22" })
      .expect(204);

    // The previously-issued access token is now rejected (session revoked).
    await authed(app, session.accessToken).get("/v1/auth/me").expect(401);
  });

  // ---------- admin-initiated ----------

  it("admin-reset returns a token (admin-channel) that resets the password", async () => {
    const { accessToken } = await loginAs(app, admin);
    const res = await authed(app, accessToken)
      .post(`/v1/auth/password/admin-reset/${target.id}`)
      .expect(201);
    expect(res.body.token).toBeTruthy();
    expect(typeof res.body.expiresAt).toBe("string");

    // The token row is attributed to the admin (created_by set).
    const rows = await resetRows(target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created_by).toBe(admin.id);

    // The returned token completes a reset.
    await request(app.getHttpServer())
      .post("/v1/auth/password/reset")
      .send({ token: res.body.token, newPassword: "admin_set_pw_33" })
      .expect(204);
    const ok = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: target.email, password: "admin_set_pw_33" })
      .expect(200);
    expect(ok.body.status).toBe("ok");
  });

  it("admin-reset is forbidden without user:manage", async () => {
    // An operator has document perms but NOT user:manage.
    const operator = await createUser(sql, tenant, {
      email: "operator@pwreset.test",
      password: "operator_pw_123",
    });
    await grantSystemRole(sql, operator, "operator");
    const { accessToken } = await loginAs(app, operator);

    await authed(app, accessToken)
      .post(`/v1/auth/password/admin-reset/${target.id}`)
      .expect(403);
  });

  it("admin-reset cannot target a user in another tenant (404)", async () => {
    const other = await createTenant(sql, { slug: "other-pwreset-tenant" });
    const stranger = await createUser(sql, other, {
      email: "stranger@other.test",
    });
    const { accessToken } = await loginAs(app, admin);

    await authed(app, accessToken)
      .post(`/v1/auth/password/admin-reset/${stranger.id}`)
      .expect(404);
  });

  // ---------- MFA interaction ----------

  it("a reset changes only the password and leaves MFA enabled", async () => {
    // Enrol + confirm a TOTP factor for the target.
    const session = await loginAs(app, target);
    const enrol = await authed(app, session.accessToken)
      .post("/v1/auth/mfa/enrol")
      .expect(200);
    const secret = enrol.body.secret as string;
    await authed(app, session.accessToken)
      .post("/v1/auth/mfa/confirm")
      .send({ code: authenticator.generate(secret) })
      .expect(200);

    // Reset the password.
    await request(app.getHttpServer())
      .post("/v1/auth/password/forgot")
      .send({ email: target.email })
      .expect(204);
    await request(app.getHttpServer())
      .post("/v1/auth/password/reset")
      .send({ token: notifier.last!.token, newPassword: "mfa_kept_pw_44" })
      .expect(204);

    // Logging in with the NEW password still hits the MFA gate.
    const login = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: target.email, password: "mfa_kept_pw_44" })
      .expect(200);
    expect(login.body.status).toBe("mfa_required");

    // The factor row is still present + verified.
    const methods = await sql`
      SELECT verified_at FROM user_mfa_methods WHERE user_id = ${target.id}`;
    expect(methods).toHaveLength(1);
    expect(methods[0]!.verified_at).not.toBeNull();
  });
});
