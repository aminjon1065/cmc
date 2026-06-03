import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { sql } from "drizzle-orm";
import type { AppConfig } from "../../config/configuration";
import { TenantDatabaseService } from "../database/tenant-database.service";
import type { TenantTx } from "../database/tenant-database.service";

/**
 * Postgres advisory-lock key for the daily retention sweep. Under HA (N API
 * instances, P3.13) every instance fires the 2 AM cron; a try-advisory-xact-lock
 * makes exactly one win and the rest skip — no double-sweep / duplicate audit
 * rows. (Same pattern as the relay / audit sealer / export / projection.)
 */
const RETENTION_LOCK_KEY = 40_211_500;

/**
 * Retention sweeper (P3.5 / ADR-0050). Soft-deletes documents past their
 * effective retention — `documents.retention_days` (override) else the nearest
 * ancestor folder's `retention_days` (inherited down the ltree) — measured from
 * `updated_at`. Legal-held documents are skipped. The daily cron is gated by
 * `RETENTION_ENABLED` + an advisory lock (HA-safe, P3.13); the manual
 * `sweep(tenantId)` always runs (endpoint).
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("RETENTION_ENABLED", { infer: true });
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: "retention-sweep" })
  async scheduledSweep(): Promise<void> {
    if (!this.enabled) return;
    try {
      const n = await this.tenantDb.runPrivileged(async (tx) => {
        // HA guard: only the instance that grabs the lock runs the sweep.
        const lockRows = (await tx.execute(
          sql`select pg_try_advisory_xact_lock(${RETENTION_LOCK_KEY}) as ok`,
        )) as unknown as Array<{ ok: boolean }>;
        if (!lockRows[0]?.ok) {
          this.logger.debug("retention sweep already running on another instance — skipping");
          return 0;
        }
        return this.runSweep(tx);
      });
      if (n > 0) this.logger.log(`retention swept ${n} document(s)`);
    } catch (err) {
      this.logger.error(
        `retention sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Soft-delete expired documents (optionally scoped to one tenant). Runs
   * privileged (cross-tenant when unscoped). Returns the number swept.
   */
  async sweep(tenantId?: string): Promise<number> {
    return this.tenantDb.runPrivileged((tx) => this.runSweep(tx, tenantId));
  }

  /** The sweep itself — runs in the caller's privileged tx. */
  private async runSweep(tx: TenantTx, tenantId?: string): Promise<number> {
    const swept = (await tx.execute(sql`
        WITH cand AS (
          SELECT d.id, d.tenant_id, d.updated_at,
            COALESCE(d.retention_days, (
              SELECT g.retention_days FROM folders g
              JOIN folders f ON f.id = d.folder_id
              WHERE g.retention_days IS NOT NULL
                AND f.path <@ g.path
                AND g.deleted_at IS NULL
              ORDER BY nlevel(g.path) DESC
              LIMIT 1
            )) AS retain
          FROM documents d
          WHERE d.deleted_at IS NULL
            AND d.status = 'ready'
            AND d.legal_hold = false
            ${tenantId ? sql`AND d.tenant_id = ${tenantId}::uuid` : sql``}
        ),
        expired AS (
          SELECT id, tenant_id FROM cand
          WHERE retain IS NOT NULL
            AND updated_at + (retain || ' days')::interval < now()
        )
        UPDATE documents SET deleted_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM expired)
        RETURNING id, tenant_id
      `)) as unknown as Array<{ id: string; tenant_id: string }>;

    if (swept.length > 0) {
      // One audit summary per affected tenant (each soft-delete is itself
      // visible via deleted_at). The async sealer hashes these into the chain.
      const byTenant = new Map<string, number>();
      for (const r of swept) {
        byTenant.set(r.tenant_id, (byTenant.get(r.tenant_id) ?? 0) + 1);
      }
      for (const [tid, count] of byTenant) {
        await tx.execute(sql`
            INSERT INTO audit_log
              (tenant_id, actor_type, action, resource_type, resource_id, outcome, metadata)
            VALUES (${tid}::uuid, 'system', 'document.retention_sweep', 'tenant',
              ${tid}, 'success', ${JSON.stringify({ count })}::jsonb)
          `);
      }
    }
    return swept.length;
  }
}
