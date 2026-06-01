import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { authenticator } from "otplib";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, type TestUser } from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/** A current TOTP code for a base32 secret. */
function totp(secret: string): string {
  return authenticator.generate(secret);
}

/**
 * MFA / TOTP (P1.2 / ADR-0020).
 *
 * The headline flows: enrol → confirm (backup codes) → login becomes two-step
 * (mfa_required, no session) → /auth/mfa/verify with a TOTP or backup code
 * issues the real session; backup codes are one-time; disable removes the gate.
 */
describe("MFA (TOTP)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let user: TestUser;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await truncateAll(sql, redis);
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "mfa-tenant",
      email: "mfa@mfa.test",
      password: "mfa_user_pwd_123",
    });
    user = fixture.user;
  });

  /** Enrol + confirm MFA for the current user; returns the TOTP secret + backup codes. */
  async function enableMfa(
    token: string,
  ): Promise<{ secret: string; backupCodes: string[] }> {
    const enrol = await authed(app, token).post("/v1/auth/mfa/enrol").expect(200);
    const secret = enrol.body.secret as string;
    const confirm = await authed(app, token)
      .post("/v1/auth/mfa/confirm")
      .send({ code: totp(secret) })
      .expect(200);
    return { secret, backupCodes: confirm.body.backupCodes as string[] };
  }

  // ---------- baseline: no MFA ----------

  it("login without MFA returns a normal session (status ok)", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.accessToken).toBeTruthy();
  });

  it("GET /auth/mfa/status reports disabled before enrolment", async () => {
    const { accessToken } = await loginAs(app, user);
    const res = await authed(app, accessToken)
      .get("/v1/auth/mfa/status")
      .expect(200);
    expect(res.body).toMatchObject({ enabled: false, pending: false });
  });

  // ---------- enrolment ----------

  it("enrol returns a secret + otpauth URI + QR data URL", async () => {
    const { accessToken } = await loginAs(app, user);
    const res = await authed(app, accessToken)
      .post("/v1/auth/mfa/enrol")
      .expect(200);
    expect(res.body.secret).toBeTruthy();
    expect(res.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    // Still pending (not confirmed) — login is NOT yet gated.
    const status = await authed(app, accessToken)
      .get("/v1/auth/mfa/status")
      .expect(200);
    expect(status.body).toMatchObject({ enabled: false, pending: true });
  });

  it("confirm with a wrong code fails; with the right code returns backup codes", async () => {
    const { accessToken } = await loginAs(app, user);
    const enrol = await authed(app, accessToken)
      .post("/v1/auth/mfa/enrol")
      .expect(200);

    await authed(app, accessToken)
      .post("/v1/auth/mfa/confirm")
      .send({ code: "000000" })
      .expect(401);

    const confirm = await authed(app, accessToken)
      .post("/v1/auth/mfa/confirm")
      .send({ code: totp(enrol.body.secret) })
      .expect(200);
    expect(Array.isArray(confirm.body.backupCodes)).toBe(true);
    expect(confirm.body.backupCodes.length).toBe(10);
  });

  // ---------- login becomes two-step ----------

  it("after MFA is enabled, login returns mfa_required (no session)", async () => {
    const { accessToken } = await loginAs(app, user);
    await enableMfa(accessToken);

    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(200);
    expect(res.body.status).toBe("mfa_required");
    expect(res.body.mfaToken).toBeTruthy();
    expect(res.body.accessToken).toBeUndefined();
  });

  it("/auth/mfa/verify with a wrong code is 401; with a valid TOTP issues a session", async () => {
    const { accessToken } = await loginAs(app, user);
    const { secret } = await enableMfa(accessToken);

    const login = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(200);
    const mfaToken = login.body.mfaToken as string;

    await request(app.getHttpServer())
      .post("/v1/auth/mfa/verify")
      .send({ mfaToken, code: "000000" })
      .expect(401);

    const verified = await request(app.getHttpServer())
      .post("/v1/auth/mfa/verify")
      .send({ mfaToken, code: totp(secret) })
      .expect(200);
    expect(verified.body.status).toBe("ok");
    expect(verified.body.accessToken).toBeTruthy();

    // The issued token actually works.
    await authed(app, verified.body.accessToken).get("/v1/auth/me").expect(200);
  });

  // ---------- backup codes ----------

  it("a backup code completes login once, then is rejected on reuse", async () => {
    const { accessToken } = await loginAs(app, user);
    const { backupCodes } = await enableMfa(accessToken);
    const code = backupCodes[0]!;

    // First login via the backup code → success.
    const login1 = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(200);
    const verify1 = await request(app.getHttpServer())
      .post("/v1/auth/mfa/verify")
      .send({ mfaToken: login1.body.mfaToken, code })
      .expect(200);
    expect(verify1.body.status).toBe("ok");

    // Second attempt with the SAME backup code → rejected (one-time).
    const login2 = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(200);
    await request(app.getHttpServer())
      .post("/v1/auth/mfa/verify")
      .send({ mfaToken: login2.body.mfaToken, code })
      .expect(401);
  });

  // ---------- disable ----------

  it("disable with a valid code removes the gate; login is single-step again", async () => {
    const { accessToken } = await loginAs(app, user);
    const { secret } = await enableMfa(accessToken);

    await authed(app, accessToken)
      .post("/v1/auth/mfa/disable")
      .send({ code: totp(secret) })
      .expect(204);

    const res = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: user.email, password: user.password })
      .expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.accessToken).toBeTruthy();
  });
});
