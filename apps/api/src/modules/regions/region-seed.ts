import type { Database } from "@cmc/db";
import { schema } from "@cmc/db";
import { DEFAULT_TJ_REGIONS } from "@cmc/contracts";

/**
 * Region seeding (P4.6 / ADR-0064), shared by the dev seed script and the e2e
 * fixtures. `db` is the owner connection (bypasses RLS) — appropriate for
 * bootstrap that writes per-tenant rows. Idempotent (keyed on tenant_id+code).
 */
type Db = Database["db"];

/** Ensure the default (Tajikistan) regions exist for a tenant. Idempotent. */
export async function ensureDefaultRegionsForTenant(
  db: Db,
  tenantId: string,
): Promise<void> {
  for (const r of DEFAULT_TJ_REGIONS) {
    await db
      .insert(schema.regions)
      .values({ tenantId, code: r.code, name: r.name })
      .onConflictDoNothing();
  }
}
