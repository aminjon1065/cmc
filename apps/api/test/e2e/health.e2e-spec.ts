import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { HealthCheckResponseSchema } from "@cmc/contracts";
import { buildTestApp } from "../helpers/test-app";

describe("GET /health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with a contract-valid payload", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    const parsed = HealthCheckResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.status).toBe("ok");
  });
});
