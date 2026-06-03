import { Injectable } from "@nestjs/common";
import { eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { schema } from "@cmc/db";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { TenantContextService } from "../../common/tenant-context/tenant-context.service";
import { RbacService } from "../rbac/rbac.service";

/**
 * The current actor's region scope (P4.6b / ADR-0064).
 *
 * - `seeAll` → no region filter (head office, `region:all`, API keys, or a
 *   non-request/background context).
 * - otherwise `regionId` is the actor's own region (null = unassigned pool),
 *   and reads are filtered to `region_id IS NOT DISTINCT FROM regionId`.
 *
 * `regionId` is always the actor's own region (even when `seeAll`), so create
 * paths can stamp it on new rows regardless of cross-region visibility.
 */
export type RegionScope = { seeAll: boolean; regionId: string | null };

@Injectable()
export class RegionScopeService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly rbac: RbacService,
  ) {}

  async current(): Promise<RegionScope> {
    const ctx = this.tenantContext.getCurrent();
    // No request context (cron / event consumer / background) → unscoped.
    if (!ctx) return { seeAll: true, regionId: null };
    // API-key principals are tenant-level service integrations, not regional
    // staff — unscoped, preserving pre-region (P3.9) behaviour.
    if (ctx.principalType === "apikey") return { seeAll: true, regionId: null };

    const regionId = await this.actorRegionId(ctx.userId);
    const seeAll = await this.rbac.hasPermission(
      ctx.tenantId,
      ctx.userId,
      "region:all",
    );
    return { seeAll, regionId };
  }

  /** The actor's own `users.region_id` (RLS-scoped to the current tenant). */
  private async actorRegionId(userId: string): Promise<string | null> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select({ regionId: schema.users.regionId })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1),
    );
    return rows[0]?.regionId ?? null;
  }
}

/**
 * A WHERE condition scoping `regionCol` to `scope`, or `undefined` when the
 * actor sees all regions (so callers can spread it into a conds array). Uses
 * `IS NOT DISTINCT FROM` so a null-region actor matches null-region rows
 * (backward-compatible with pre-region data) and HQ is handled by `seeAll`.
 */
export function regionScopeCondition(
  regionCol: AnyPgColumn,
  scope: RegionScope,
): SQL | undefined {
  if (scope.seeAll) return undefined;
  return sql`${regionCol} is not distinct from ${scope.regionId}::uuid`;
}
