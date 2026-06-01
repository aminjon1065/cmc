import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import type { Redis } from "ioredis";
import { buildTestApp } from "../helpers/test-app";
import { ownerSql, truncateAll } from "../helpers/test-db";
import {
  createTenant,
  createUser,
  createTenantWithAdmin,
  type TestUser,
} from "../helpers/test-fixtures";
import { loginAs, authed } from "../helpers/test-auth";
import { REDIS } from "../../src/modules/redis/redis.tokens";

/**
 * Tenant branding (P0.11 / ADR-0018).
 *
 * `GET /branding` is context-aware:
 *   - anonymous → the DEFAULT_TENANT_SLUG ("default" in test env) tenant's
 *     branding
 *   - authenticated → the caller's own tenant branding
 *
 * The headline guarantees: a second tenant gets ITS OWN copy (no leak of the
 * default tenant's values), and a tenant with no branding row falls back to
 * the generic DEFAULT_BRANDING — never to another tenant's data.
 */
async function setBranding(
  sql: ReturnType<typeof ownerSql>,
  tenantId: string,
  copy: Record<string, string>,
  opts: { locale?: string; logoUrl?: string | null } = {},
): Promise<void> {
  await sql`
    INSERT INTO tenant_branding (tenant_id, locale_default, logo_url, copy, theme)
    VALUES (${tenantId}, ${opts.locale ?? "en"}, ${opts.logoUrl ?? null},
            ${sql.json(copy)}, ${sql.json({})})
    ON CONFLICT (tenant_id) DO UPDATE SET copy = EXCLUDED.copy
  `;
}

describe("Tenant branding", () => {
  let app: INestApplication;
  let sql: ReturnType<typeof ownerSql>;
  let redis: Redis;

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
  });

  // ---------- anonymous → default tenant ----------

  it("anonymous GET /branding returns the default tenant's branding", async () => {
    const def = await createTenant(sql, { slug: "default" });
    await setBranding(sql, def.id, {
      orgName: "Crisis Management Center",
      orgShort: "Civil Defense · TJ",
      statusLocation: "National Operational Status · Dushanbe",
    });

    const res = await request(app.getHttpServer())
      .get("/v1/branding")
      .expect(200);

    expect(res.body.tenantSlug).toBe("default");
    expect(res.body.copy.orgName).toBe("Crisis Management Center");
    expect(res.body.copy.statusLocation).toBe(
      "National Operational Status · Dushanbe",
    );
  });

  it("anonymous fills missing copy keys from the generic default", async () => {
    const def = await createTenant(sql, { slug: "default" });
    // Only set orgName — every other key must come from DEFAULT_BRANDING_COPY.
    await setBranding(sql, def.id, { orgName: "Partial Org" });

    const res = await request(app.getHttpServer())
      .get("/v1/branding")
      .expect(200);

    expect(res.body.copy.orgName).toBe("Partial Org");
    // A key we didn't set falls back to the generic default (NOT empty/null).
    expect(res.body.copy.muralKicker).toBe(
      "Unified enterprise operational intelligence",
    );
  });

  it("anonymous with no default tenant → generic DEFAULT_BRANDING", async () => {
    // No tenant at all.
    const res = await request(app.getHttpServer())
      .get("/v1/branding")
      .expect(200);

    expect(res.body.tenantSlug).toBe("default");
    expect(res.body.copy.orgName).toBe("Operational Intelligence Platform");
    // No TJ leak.
    expect(JSON.stringify(res.body)).not.toContain("Tajikistan");
  });

  // ---------- authenticated → own tenant ----------

  it("authenticated GET /branding returns the caller's tenant branding", async () => {
    const { tenant, user } = await createTenantWithAdmin(sql, {
      tenantSlug: "acme",
      email: "ops@acme.test",
      password: "acme_pwd_strong_12",
    });
    await setBranding(sql, tenant.id, {
      orgName: "Acme Operations",
      orgShort: "Acme Corp",
    });

    const { accessToken } = await loginAs(app, user);
    const res = await authed(app, accessToken).get("/v1/branding").expect(200);

    expect(res.body.tenantSlug).toBe("acme");
    expect(res.body.copy.orgName).toBe("Acme Operations");
  });

  // ---------- isolation ----------

  it("a second tenant gets its OWN branding, never the default tenant's", async () => {
    // Default tenant carries the TJ-CMC copy.
    const def = await createTenant(sql, { slug: "default" });
    await setBranding(sql, def.id, {
      orgName: "Crisis Management Center",
      country: "Tajikistan",
    });
    // Tenant B has its own branding.
    const tenantB = await createTenant(sql, { slug: "tenant-b" });
    const userB: TestUser = await createUser(sql, tenantB, {
      email: "ops@b.test",
      password: "tenantb_pwd_strong",
    });
    await setBranding(sql, tenantB.id, {
      orgName: "Tenant B Command",
      country: "Elsewhere",
    });

    const { accessToken } = await loginAs(app, userB);
    const res = await authed(app, accessToken).get("/v1/branding").expect(200);

    expect(res.body.tenantSlug).toBe("tenant-b");
    expect(res.body.copy.orgName).toBe("Tenant B Command");
    // The TJ specifics from the default tenant must NOT leak.
    expect(JSON.stringify(res.body)).not.toContain("Tajikistan");
    expect(JSON.stringify(res.body)).not.toContain("Crisis Management Center");
  });

  it("authenticated tenant with no branding row → generic default (no leak)", async () => {
    // Default tenant has branding; the caller's tenant does NOT.
    const def = await createTenant(sql, { slug: "default" });
    await setBranding(sql, def.id, { orgName: "Crisis Management Center" });

    const { user } = await createTenantWithAdmin(sql, {
      tenantSlug: "barebones",
      email: "ops@barebones.test",
      password: "barebones_pwd_str",
    });

    const { accessToken } = await loginAs(app, user);
    const res = await authed(app, accessToken).get("/v1/branding").expect(200);

    expect(res.body.tenantSlug).toBe("barebones");
    expect(res.body.copy.orgName).toBe("Operational Intelligence Platform");
    expect(JSON.stringify(res.body)).not.toContain("Crisis Management Center");
  });
});
