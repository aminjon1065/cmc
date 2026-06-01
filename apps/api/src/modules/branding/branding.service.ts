import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import {
  DEFAULT_BRANDING,
  DEFAULT_BRANDING_COPY,
  type BrandingCopy,
  type TenantBranding,
  type UpdateBrandingRequest,
} from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { TenantContextService } from "../../common/tenant-context/tenant-context.service";
import { AuditService } from "../audit/audit.service";

/**
 * Resolves the branding payload for the current request (P0.11 / ADR-0018).
 *
 *  - Authenticated request → the caller's own tenant branding, read inside
 *    the request's tenant-scoped transaction (RLS guarantees it can only see
 *    its own row).
 *  - Anonymous request (login, root metadata) → the DEFAULT_TENANT_SLUG
 *    tenant's branding, read via a privileged (RLS-bypass) transaction since
 *    there is no tenant context yet.
 *
 * In every case a missing row or missing keys fall back to the generic
 * DEFAULT_BRANDING — the Tajikistan-CMC specifics live only in the seeded row,
 * never in code.
 */
@Injectable()
export class BrandingService {
  private readonly defaultTenantSlug: string;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.defaultTenantSlug = config.get("DEFAULT_TENANT_SLUG", { infer: true });
  }

  /**
   * Update the current tenant's branding (P1.4d). Upserts the single
   * `tenant_branding` row, MERGING any provided copy keys into the existing
   * bag (so a partial form submission preserves the rest). Runs inside the
   * request's tenant transaction — RLS confines it to the caller's own row.
   * `theme` is left untouched (reserved, TD-023).
   */
  async updateBranding(
    tenantId: string,
    patch: UpdateBrandingRequest,
    actor: { actorId: string; ip?: string | null; userAgent?: string | null },
  ): Promise<TenantBranding> {
    await this.tenantDb.run(async (tx) => {
      const existing = (
        await tx
          .select()
          .from(schema.tenantBranding)
          .where(eq(schema.tenantBranding.tenantId, tenantId))
          .limit(1)
      )[0];

      const mergedCopy: Record<string, unknown> = {
        ...((existing?.copy as Record<string, unknown>) ?? {}),
        ...(patch.copy ?? {}),
      };
      const localeDefault =
        patch.localeDefault ?? existing?.localeDefault ?? "en";
      const logoUrl =
        patch.logoUrl !== undefined ? patch.logoUrl : (existing?.logoUrl ?? null);

      await tx
        .insert(schema.tenantBranding)
        .values({
          tenantId,
          localeDefault,
          logoUrl,
          copy: mergedCopy,
          theme: (existing?.theme as Record<string, unknown>) ?? {},
        })
        .onConflictDoUpdate({
          target: schema.tenantBranding.tenantId,
          set: {
            localeDefault,
            logoUrl,
            copy: mergedCopy,
            updatedAt: sql`now()`,
          },
        });
    });

    await this.audit.record({
      tenantId,
      actorId: actor.actorId,
      actorType: "user",
      action: "tenant.branding_updated",
      resourceType: "tenant",
      resourceId: tenantId,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        fields: Object.keys(patch),
        copyKeys: patch.copy ? Object.keys(patch.copy) : [],
      },
    });

    return this.resolve();
  }

  async resolve(): Promise<TenantBranding> {
    const ctx = this.tenantContext.getCurrent();
    if (ctx) {
      // Authenticated: read own row inside the active tenant transaction.
      const row = await this.tenantDb.run((tx) =>
        tx
          .select()
          .from(schema.tenantBranding)
          .where(eq(schema.tenantBranding.tenantId, ctx.tenantId))
          .limit(1),
      );
      return this.toBranding(ctx.tenantSlug, row[0]);
    }

    // Anonymous: resolve the default tenant + its branding under bypass.
    return this.tenantDb.runPrivileged(async (tx) => {
      const tenantRows = await tx
        .select({ id: schema.tenants.id, slug: schema.tenants.slug })
        .from(schema.tenants)
        .where(
          and(
            eq(schema.tenants.slug, this.defaultTenantSlug),
            isNull(schema.tenants.deletedAt),
          ),
        )
        .limit(1);

      const tenant = tenantRows[0];
      if (!tenant) {
        // No default tenant yet (fresh DB before seed) → generic default.
        return DEFAULT_BRANDING;
      }

      const brandingRows = await tx
        .select()
        .from(schema.tenantBranding)
        .where(eq(schema.tenantBranding.tenantId, tenant.id))
        .limit(1);

      return this.toBranding(tenant.slug, brandingRows[0]);
    });
  }

  /**
   * Shape a DB row into the contract payload, filling any missing copy keys
   * from the generic default so the frontend always gets a complete object.
   */
  private toBranding(
    tenantSlug: string,
    row: typeof schema.tenantBranding.$inferSelect | undefined,
  ): TenantBranding {
    if (!row) {
      // Known tenant, no branding row → generic default tagged with the slug.
      return { ...DEFAULT_BRANDING, tenantSlug };
    }
    const copy: BrandingCopy = {
      ...DEFAULT_BRANDING_COPY,
      ...((row.copy as Partial<BrandingCopy>) ?? {}),
    };
    return {
      tenantSlug,
      localeDefault: row.localeDefault,
      logoUrl: row.logoUrl ?? null,
      copy,
      theme: (row.theme as Record<string, string>) ?? {},
    };
  }
}
