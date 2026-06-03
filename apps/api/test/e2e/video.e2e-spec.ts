import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenantWithAdmin,
  createUser,
  grantSystemRole,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/** Decode a LiveKit JWT's payload (no verify needed — we assert the grant shape). */
function decodeJwt(token: string): {
  sub?: string;
  video?: { room?: string; roomJoin?: boolean; canPublish?: boolean };
} {
  return JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
  );
}

/**
 * Video conferencing substrate (P4.2a / ADR-0061). The LiveKit SFU is gated off
 * in tests; these drive the rooms backend + the room-scoped token mint (pure
 * JWT signing, no WebRTC) against real Postgres. Real media is a manual/Playwright
 * concern.
 */
describe("Video rooms (P4.2a)", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;
  let adminToken: string;
  let opToken: string;
  let opUserId: string;
  let viewerToken: string;
  let otherToken: string;
  let tenantId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    sql = ownerSql();
    redis = app.get<Redis>(REDIS);
    await truncateAll(sql, redis);
    const { tenant, user: admin } = await createTenantWithAdmin(sql);
    tenantId = tenant.id;
    adminToken = (await loginAs(app, admin)).accessToken;
    const op = await createUser(sql, tenant);
    opUserId = op.id;
    await grantSystemRole(sql, op, "operator"); // video:read + video:write
    opToken = (await loginAs(app, op)).accessToken;
    const viewer = await createUser(sql, tenant);
    viewerToken = (await loginAs(app, viewer)).accessToken;
    otherToken = (await loginAs(app, (await createTenantWithAdmin(sql)).user))
      .accessToken;
  });

  afterAll(async () => {
    await app.close();
    await sql.end({ timeout: 2 });
  });

  function createRoom(token: string, body: Record<string, unknown>) {
    return authed(app, token).post("/v1/video/rooms").send(body);
  }

  it("creates a room, lists it, and fetches it", async () => {
    const res = await createRoom(opToken, { name: "Briefing" }).expect(201);
    const room = res.body.room;
    expect(room.name).toBe("Briefing");
    expect(room.status).toBe("open");
    expect(room.livekitRoom).toMatch(/^room-/);
    expect(room.createdBy).toBe(opUserId);
    expect(room.linkedType).toBeNull();

    const list = await authed(app, adminToken).get("/v1/video/rooms").expect(200);
    expect(list.body.rooms.map((r: { id: string }) => r.id)).toContain(room.id);

    const got = await authed(app, opToken)
      .get(`/v1/video/rooms/${room.id}`)
      .expect(200);
    expect(got.body.room.id).toBe(room.id);
  });

  it("mints a room-scoped LiveKit join token", async () => {
    const room = (await createRoom(opToken, { name: "Token room" }).expect(201))
      .body.room;
    const res = await authed(app, opToken)
      .post(`/v1/video/rooms/${room.id}/token`)
      .expect(201);
    expect(res.body.roomName).toBe(room.livekitRoom);
    expect(res.body.identity).toBe(opUserId);
    expect(res.body.enabled).toBe(false); // LIVEKIT_ENABLED off in tests
    expect(res.body.url).toMatch(/^wss?:\/\//);

    const claims = decodeJwt(res.body.token);
    expect(claims.sub).toBe(opUserId);
    expect(claims.video?.room).toBe(room.livekitRoom);
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.canPublish).toBe(true);
  });

  it("enforces video RBAC (viewer has neither read nor write)", async () => {
    await authed(app, viewerToken).get("/v1/video/rooms").expect(403);
    await createRoom(viewerToken, { name: "nope" }).expect(403);
  });

  it("isolates rooms by tenant (cross-tenant fetch → 404)", async () => {
    const room = (await createRoom(opToken, { name: "Private" }).expect(201))
      .body.room;
    await authed(app, otherToken).get(`/v1/video/rooms/${room.id}`).expect(404);
  });

  it("validates the reserved link (both linkedType + linkedId, or neither)", async () => {
    await createRoom(opToken, {
      name: "half-linked",
      linkedType: "incident",
    }).expect(400);
    const ok = await createRoom(opToken, {
      name: "linked",
      linkedType: "incident",
      linkedId: "00000000-0000-0000-0000-000000000001",
    }).expect(201);
    expect(ok.body.room.linkedType).toBe("incident");
  });

  it("closes a room (creator / manager), and blocks joining a closed room", async () => {
    const room = (await createRoom(opToken, { name: "To close" }).expect(201))
      .body.room;

    // Creator closes their own room.
    const closed = await authed(app, opToken)
      .post(`/v1/video/rooms/${room.id}/close`)
      .expect(200);
    expect(closed.body.room.status).toBe("closed");

    // A closed room cannot be joined.
    await authed(app, opToken)
      .post(`/v1/video/rooms/${room.id}/token`)
      .expect(409);

    // A non-creator without video:manage cannot close someone else's room…
    const adminRoom = (await createRoom(adminToken, { name: "Admin's" }).expect(
      201,
    )).body.room;
    await authed(app, opToken)
      .post(`/v1/video/rooms/${adminRoom.id}/close`)
      .expect(403);
    // …but the tenant admin (video:manage via "*") can.
    await authed(app, adminToken)
      .post(`/v1/video/rooms/${adminRoom.id}/close`)
      .expect(200);
  });

  // ---------- recordings (P4.2c) ----------

  it("recording start needs video:manage + a running egress (503 when disabled)", async () => {
    const room = (await createRoom(opToken, { name: "Rec room" }).expect(201))
      .body.room;
    // op holds video:write but not video:manage → 403 at the guard.
    await authed(app, opToken)
      .post(`/v1/video/rooms/${room.id}/recordings`)
      .expect(403);
    // admin passes the guard but LIVEKIT_ENABLED is off in tests → 503.
    await authed(app, adminToken)
      .post(`/v1/video/rooms/${room.id}/recordings`)
      .expect(503);
    const list = await authed(app, opToken)
      .get(`/v1/video/rooms/${room.id}/recordings`)
      .expect(200);
    expect(list.body.recordings).toEqual([]);
  });

  it("recording download returns a presigned URL; cross-tenant → 404", async () => {
    const room = (await createRoom(opToken, { name: "Dl room" }).expect(201))
      .body.room;
    const key = `recordings/${tenantId}/${room.id}/seed.mp4`;
    const [rec] = await sql<{ id: string }[]>`
      INSERT INTO video_recordings (tenant_id, room_id, status, s3_key, started_by)
      VALUES (${tenantId}, ${room.id}, 'complete', ${key}, NULL)
      RETURNING id`;
    const dl = await authed(app, opToken)
      .get(`/v1/video/recordings/${rec!.id}/download`)
      .expect(200);
    expect(dl.body.url).toContain("seed.mp4");
    // Another tenant cannot resolve it (RLS) → 404.
    await authed(app, otherToken)
      .get(`/v1/video/recordings/${rec!.id}/download`)
      .expect(404);
    // It shows in the room's recordings list.
    const list = await authed(app, opToken)
      .get(`/v1/video/rooms/${room.id}/recordings`)
      .expect(200);
    expect(list.body.recordings.map((r: { id: string }) => r.id)).toContain(
      rec!.id,
    );
  });

  it("filters rooms by linked incident", async () => {
    const incidentId = "00000000-0000-0000-0000-0000000000aa";
    const linked = (
      await createRoom(opToken, {
        name: "Incident call",
        linkedType: "incident",
        linkedId: incidentId,
      }).expect(201)
    ).body.room;
    const filtered = await authed(app, opToken)
      .get(`/v1/video/rooms?linkedType=incident&linkedId=${incidentId}`)
      .expect(200);
    expect(
      filtered.body.rooms.map((r: { id: string }) => r.id),
    ).toContain(linked.id);
    expect(
      filtered.body.rooms.every(
        (r: { linkedType: string; linkedId: string }) =>
          r.linkedType === "incident" && r.linkedId === incidentId,
      ),
    ).toBe(true);
  });
});
