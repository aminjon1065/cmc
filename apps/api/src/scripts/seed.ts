/**
 * One-shot dev seed: ensures a default tenant + admin user exist.
 *
 * Idempotent — running twice is safe; existing rows are left untouched.
 *
 * Run with:  pnpm --filter @cmc/api seed
 *
 * RLS bypass: this script uses the postgres `cmc` role (owner of the
 * tables) which BYPASS RLS automatically; that's intentional — bootstrap
 * has to run before any tenant context exists.
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDatabase, schema } from "@cmc/db";
import { loadConfig } from "../config/configuration";
import { AuthService } from "../modules/auth/auth.service";
import { TJ_CMC_BRANDING } from "./seed-branding";
import {
  ensureSystemRolesForTenant,
  assignRoleToUser,
} from "../modules/rbac/rbac-seed";
import { ensureDefaultRegionsForTenant } from "../modules/regions/region-seed";

loadEnv({ path: resolve(__dirname, "../../.env") });

async function main() {
  const config = loadConfig();
  // Seed connects as the owner (`cmc`) — that role legitimately bypasses
  // RLS and has the privileges needed to bootstrap rows pre-tenant.
  const ownerUrl = config.DATABASE_OWNER_URL ?? config.DATABASE_URL;
  const { db, close } = createDatabase(ownerUrl, { max: 4 });

  try {
    // Belt-and-suspenders: even owner connections will respect a SET if
    // we ever switch to a non-superuser owner. This makes the bypass
    // explicit and visible in audit/logs.
    await db.execute(sql.raw(`SET app.bypass_rls = 'on'`));

    // 1. Default tenant.
    let tenant = (
      await db
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.slug, config.SEED_TENANT_SLUG))
        .limit(1)
    )[0];

    if (!tenant) {
      const inserted = await db
        .insert(schema.tenants)
        .values({
          slug: config.SEED_TENANT_SLUG,
          name: config.SEED_TENANT_NAME,
        })
        .returning();
      tenant = inserted[0]!;
      console.log(`✓ Created tenant ${tenant.slug} (${tenant.id})`);
    } else {
      console.log(`= Tenant ${tenant.slug} already exists (${tenant.id})`);
    }

    // 2. Admin user.
    const adminEmail = config.SEED_ADMIN_EMAIL.toLowerCase();
    const existingAdmin = (
      await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, adminEmail))
        .limit(1)
    )[0];

    if (!existingAdmin) {
      const passwordHash = await AuthService.hashPassword(
        config.SEED_ADMIN_PASSWORD,
      );
      const [admin] = await db
        .insert(schema.users)
        .values({
          tenantId: tenant.id,
          email: adminEmail,
          name: config.SEED_ADMIN_NAME,
          passwordHash,
          isActive: true,
        })
        .returning();
      console.log(`✓ Created admin user ${admin!.email} (${admin!.id})`);
      console.log(
        `  Login with: email=${admin!.email}  password=${config.SEED_ADMIN_PASSWORD}`,
      );
      console.log(
        "  ⚠  Change SEED_ADMIN_PASSWORD in apps/api/.env before going to anything but local dev.",
      );
    } else {
      console.log(`= Admin user ${existingAdmin.email} already exists`);
    }

    // 3. Tenant branding (P0.11 / ADR-0018). Upsert so re-seeding refreshes
    //    the copy. This is the ONLY place the TJ-CMC specifics live.
    await db
      .insert(schema.tenantBranding)
      .values({
        tenantId: tenant.id,
        localeDefault: TJ_CMC_BRANDING.localeDefault,
        logoUrl: TJ_CMC_BRANDING.logoUrl,
        copy: TJ_CMC_BRANDING.copy,
        theme: TJ_CMC_BRANDING.theme,
      })
      .onConflictDoUpdate({
        target: schema.tenantBranding.tenantId,
        set: {
          localeDefault: TJ_CMC_BRANDING.localeDefault,
          logoUrl: TJ_CMC_BRANDING.logoUrl,
          copy: TJ_CMC_BRANDING.copy,
          theme: TJ_CMC_BRANDING.theme,
          updatedAt: sql`now()`,
        },
      });
    console.log(`✓ Branding set for tenant ${tenant.slug}`);

    // 4. RBAC (P1.1 / ADR-0019): the global permission catalog, the system
    //    roles for the default tenant, and the admin's tenant_admin grant.
    const roleIdBySlug = await ensureSystemRolesForTenant(db, tenant.id);
    console.log(
      `✓ RBAC: permission catalog + ${roleIdBySlug.size} system roles for ${tenant.slug}`,
    );

    // P4.6: default (Tajikistan) regions for the tenant. Idempotent.
    await ensureDefaultRegionsForTenant(db, tenant.id);
    console.log(`✓ Regions: default Tajikistan regions for ${tenant.slug}`);

    const adminUser = (
      await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, adminEmail))
        .limit(1)
    )[0];
    const adminRoleId = roleIdBySlug.get("tenant_admin");
    if (adminUser && adminRoleId) {
      await assignRoleToUser(db, {
        userId: adminUser.id,
        roleId: adminRoleId,
        tenantId: tenant.id,
      });
      console.log(`✓ Granted tenant_admin to ${adminEmail}`);
    }

    // 5. Demo accounts for local testing (idempotent). They share the admin
    //    seed password for convenience — local dev only.
    const demoUsers: { email: string; name: string; role: string }[] = [
      { email: "analyst@cmc.local", name: "Demo Analyst", role: "analyst" },
      { email: "operator@cmc.local", name: "Demo Operator", role: "operator" },
      { email: "auditor@cmc.local", name: "Demo Auditor", role: "auditor" },
    ];
    const demoPassword = config.SEED_ADMIN_PASSWORD;
    const demoHash = await AuthService.hashPassword(demoPassword);
    for (const u of demoUsers) {
      const email = u.email.toLowerCase();
      let row = (
        await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, email))
          .limit(1)
      )[0];
      if (!row) {
        const [created] = await db
          .insert(schema.users)
          .values({
            tenantId: tenant.id,
            email,
            name: u.name,
            passwordHash: demoHash,
            isActive: true,
          })
          .returning({ id: schema.users.id });
        row = created!;
        console.log(`✓ Created ${u.role} user ${email}`);
      } else {
        console.log(`= User ${email} already exists`);
      }
      const roleId = roleIdBySlug.get(u.role);
      if (row && roleId) {
        await assignRoleToUser(db, {
          userId: row.id,
          roleId,
          tenantId: tenant.id,
        });
        console.log(`✓ Granted ${u.role} to ${email}`);
      }
    }
    console.log(
      `  Demo logins (password=${demoPassword}): ${demoUsers
        .map((u) => u.email)
        .join(", ")}`,
    );

    console.log("Seed complete.");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
