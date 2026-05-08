import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { LoginResponse, RefreshResponse } from "@cmc/contracts";
import type { TestUser } from "./test-fixtures";

/**
 * Login through the real /auth/login endpoint and return the issued
 * token bundle. Tests use the access token in subsequent calls; the
 * refresh token is available for tests that exercise rotation/replay.
 */
export async function loginAs(
  app: INestApplication,
  user: TestUser,
): Promise<LoginResponse> {
  const res = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ email: user.email, password: user.password });

  if (res.status !== 200) {
    throw new Error(
      `loginAs(${user.email}) failed with HTTP ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  return res.body as LoginResponse;
}

/**
 * Hit /auth/refresh and return the new bundle. Any non-200 throws — the
 * caller is expected to assert specifically when testing failure paths.
 */
export async function refresh(
  app: INestApplication,
  refreshToken: string,
): Promise<RefreshResponse> {
  const res = await request(app.getHttpServer())
    .post("/auth/refresh")
    .send({ refreshToken });
  if (res.status !== 200) {
    throw new Error(
      `refresh failed with HTTP ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  return res.body as RefreshResponse;
}

/**
 * Helper for sending an authenticated request. Wraps supertest's chain
 * with a Bearer header so tests don't repeat themselves.
 */
export function authed(app: INestApplication, accessToken: string) {
  const agent = request.agent(app.getHttpServer());
  const wrap = <T extends "get" | "post" | "put" | "delete" | "patch">(
    method: T,
  ) =>
    function (path: string) {
      return agent[method](path).set("Authorization", `Bearer ${accessToken}`);
    };

  return {
    get: wrap("get"),
    post: wrap("post"),
    put: wrap("put"),
    delete: wrap("delete"),
    patch: wrap("patch"),
  };
}
