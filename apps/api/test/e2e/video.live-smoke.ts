import { RoomServiceClient } from "livekit-server-sdk";

/**
 * LIVE SMOKE (not in the default suite). Proves the real LiveKit SFU accepts our
 * dev API key/secret (the key footgun: livekit.yaml `keys` must match the API's
 * LIVEKIT_API_KEY/SECRET) and is reachable. Real WebRTC media is out of scope
 * for a headless test. Run with LiveKit up:
 *
 *   docker compose -f infra/docker-compose.yml --env-file infra/.env up -d livekit
 *   cd apps/api && npx jest --config test/jest-e2e.config.js \
 *     --testRegex 'video\.live-smoke\.ts$' --forceExit
 */
const API_URL = process.env.LIVEKIT_API_URL ?? "http://localhost:7880";
const API_KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const API_SECRET =
  process.env.LIVEKIT_API_SECRET ?? "devsecret_change_me_minimum_32_chars";

describe("LIVE: LiveKit SFU reachable + key accepted", () => {
  it("creates, lists, and deletes a room via the server SDK", async () => {
    const svc = new RoomServiceClient(API_URL, API_KEY, API_SECRET);
    const name = `smoke-${Date.now()}`;
    await svc.createRoom({ name });
    const rooms = await svc.listRooms();
    expect(rooms.map((r) => r.name)).toContain(name);
    await svc.deleteRoom(name);
    // eslint-disable-next-line no-console
    console.log("LIVE LiveKit OK: room created/listed/deleted");
  }, 30_000);
});
