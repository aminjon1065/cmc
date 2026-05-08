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

loadEnv({ path: resolve(__dirname, "../../.env") });

async function main() {
  const config = loadConfig();
  const { db, close } = createDatabase(config.DATABASE_URL, { max: 4 });

  try {
    // Mark this connection as a privileged session so RLS policies (once
    // they exist) allow the cross-tenant inserts the seed performs.
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

    console.log("Seed complete.");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
