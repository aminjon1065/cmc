import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import {
  LoginResponseSchema,
  MeResponseSchema,
  RefreshResponseSchema,
  SessionsListResponseSchema,
} from "@cmc/contracts";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import { createTenantWithAdmin, type TestUser } from "../helpers/test-fixtures";
import { authed, loginAs, refresh } from "../helpers/test-auth";

describe("Auth flow", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let user: TestUser;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await truncateAll(sql);
    const fixture = await createTenantWithAdmin(sql, {
      tenantSlug: "auth-test",
      email: "alice@auth.test",
      password: "alice_password_123",
    });
    user = fixture.user;
  });

  // ---------- /auth/login ----------

  describe("POST /auth/login", () => {
    it("issues a valid token bundle on correct credentials", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: user.email, password: user.password })
        .expect(200);

      const parsed = LoginResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.user.email).toBe(user.email);
      expect(parsed.data?.user.tenantSlug).toBe("auth-test");
      expect(parsed.data?.accessToken.length).toBeGreaterThan(20);
      expect(parsed.data?.refreshToken.length).toBeGreaterThan(20);
    });

    it("rejects an unknown user with 401 and audits user_not_found", async () => {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "ghost@auth.test", password: "doesnt_matter_8" })
        .expect(401);

      const auditRows = await sql<
        { reason: string; outcome: string }[]
      >`SELECT outcome, metadata->>'reason' AS reason FROM audit_log
        WHERE action = 'user.login' AND outcome = 'failure'`;
      expect(auditRows[0]?.reason).toBe("user_not_found");
    });

    it("rejects a wrong password with 401 and audits wrong_password", async () => {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: user.email, password: "definitely_wrong_pwd" })
        .expect(401);

      const auditRows = await sql<
        { reason: string }[]
      >`SELECT metadata->>'reason' AS reason FROM audit_log
        WHERE action = 'user.login' AND outcome = 'failure'`;
      expect(auditRows[0]?.reason).toBe("wrong_password");
    });

    it("rejects malformed payloads with 400 (DTO validation)", async () => {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "not-an-email", password: "x" })
        .expect(400);
    });
  });

  // ---------- /auth/me ----------

  describe("GET /auth/me", () => {
    it("returns 401 without a bearer token", async () => {
      await request(app.getHttpServer()).get("/auth/me").expect(401);
    });

    it("returns 401 for a malformed token", async () => {
      await request(app.getHttpServer())
        .get("/auth/me")
        .set("Authorization", "Bearer this.is.not.a.jwt")
        .expect(401);
    });

    it("returns the current user for a valid bearer token", async () => {
      const login = await loginAs(app, user);
      const res = await authed(app, login.accessToken)
        .get("/auth/me")
        .expect(200);

      const parsed = MeResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.user.id).toBe(user.id);
      expect(parsed.data?.user.email).toBe(user.email);
    });
  });

  // ---------- /auth/refresh ----------

  describe("POST /auth/refresh", () => {
    it("rotates: new pair works, old refresh dies", async () => {
      const login = await loginAs(app, user);

      const rot = await request(app.getHttpServer())
        .post("/auth/refresh")
        .send({ refreshToken: login.refreshToken })
        .expect(200);

      const parsed = RefreshResponseSchema.safeParse(rot.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.refreshToken).not.toBe(login.refreshToken);

      // New access works.
      await authed(app, parsed.data!.accessToken).get("/auth/me").expect(200);

      // Old refresh now points at a revoked session — replay path → 401.
      await request(app.getHttpServer())
        .post("/auth/refresh")
        .send({ refreshToken: login.refreshToken })
        .expect(401);
    });

    it("burns the entire family on refresh-token replay", async () => {
      const login = await loginAs(app, user);
      const rotated = await refresh(app, login.refreshToken);

      // Replay the original — server burns the family.
      await request(app.getHttpServer())
        .post("/auth/refresh")
        .send({ refreshToken: login.refreshToken })
        .expect(401);

      // The post-rotation tokens are now ALSO dead: the next refresh
      // (using the still-fresh token returned by the legitimate rotate)
      // is rejected because its session was burned.
      await request(app.getHttpServer())
        .post("/auth/refresh")
        .send({ refreshToken: rotated.refreshToken })
        .expect(401);

      // Access from the burnt session no longer authenticates either.
      await authed(app, rotated.accessToken).get("/auth/me").expect(401);

      // DB shows the whole family marked rotation_replay or _superseded.
      const sessions = await sql<{ revoked_reason: string }[]>`
        SELECT revoked_reason FROM sessions ORDER BY created_at
      `;
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(sessions.every((s) => s.revoked_reason !== null)).toBe(true);
    });

    it("rejects an unknown refresh token with 401", async () => {
      await request(app.getHttpServer())
        .post("/auth/refresh")
        .send({ refreshToken: "a".repeat(48) })
        .expect(401);
    });
  });

  // ---------- /auth/logout ----------

  describe("POST /auth/logout", () => {
    it("revokes the current session — subsequent /auth/me is 401", async () => {
      const login = await loginAs(app, user);
      await authed(app, login.accessToken).post("/auth/logout").expect(204);
      await authed(app, login.accessToken).get("/auth/me").expect(401);
    });

    it("requires authentication", async () => {
      await request(app.getHttpServer()).post("/auth/logout").expect(401);
    });
  });

  // ---------- /auth/sessions ----------

  describe("GET /auth/sessions", () => {
    it("lists only the caller's active sessions, with current flagged", async () => {
      // Login twice — two sessions for the same user.
      const a = await loginAs(app, user);
      const b = await loginAs(app, user);

      const res = await authed(app, a.accessToken)
        .get("/auth/sessions")
        .expect(200);
      const parsed = SessionsListResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.sessions.length).toBe(2);

      const current = parsed.data!.sessions.filter((s) => s.current);
      expect(current.length).toBe(1);

      // Voucher: the same query from the other access token marks the
      // other session as current.
      const resB = await authed(app, b.accessToken)
        .get("/auth/sessions")
        .expect(200);
      const currentB = SessionsListResponseSchema.parse(resB.body)
        .sessions.filter((s) => s.current)
        .map((s) => s.id);
      expect(currentB[0]).not.toEqual(current[0]?.id);
    });
  });

  describe("DELETE /auth/sessions/:id", () => {
    it("revokes another of the caller's own sessions; that token stops working", async () => {
      const a = await loginAs(app, user);
      const b = await loginAs(app, user);

      // Find b's session id from a's perspective.
      const list = await authed(app, a.accessToken)
        .get("/auth/sessions")
        .expect(200);
      const bSession = SessionsListResponseSchema.parse(
        list.body,
      ).sessions.find((s) => !s.current);
      expect(bSession).toBeDefined();

      await authed(app, a.accessToken)
        .delete(`/auth/sessions/${bSession!.id}`)
        .expect(204);

      // b's access token is now dead.
      await authed(app, b.accessToken).get("/auth/me").expect(401);
      // a still works.
      await authed(app, a.accessToken).get("/auth/me").expect(200);
    });

    it("refuses to revoke the current session (use logout)", async () => {
      const a = await loginAs(app, user);
      const list = await authed(app, a.accessToken)
        .get("/auth/sessions")
        .expect(200);
      const current = SessionsListResponseSchema.parse(list.body).sessions.find(
        (s) => s.current,
      );
      expect(current).toBeDefined();

      await authed(app, a.accessToken)
        .delete(`/auth/sessions/${current!.id}`)
        .expect(403);
    });

    it("returns 404 for an unknown id", async () => {
      const a = await loginAs(app, user);
      await authed(app, a.accessToken)
        .delete("/auth/sessions/00000000-0000-0000-0000-000000000000")
        .expect(404);
    });
  });
});
