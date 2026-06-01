import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { schema } from "@cmc/db";
import {
  AUDIT_SYSTEM_SCOPE,
  type AuditAnchorResponse,
  type AuditChainVerifyResponse,
  type AuditSealResponse,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { StorageService } from "../storage/storage.service";
import type { AppConfig } from "../../config/configuration";

type AuditRow = typeof schema.auditLog.$inferSelect;
type AnchorRow = typeof schema.auditChainAnchor.$inferSelect;

/** Advisory-lock key so only one sealer runs at a time cluster-wide. */
const SEAL_LOCK_KEY = 40_211_100;
const DAY_MS = 86_400_000;

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic JSON: object keys sorted recursively so the same logical
 * content always hashes the same, regardless of column/JSONB key ordering.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * Tamper-evident hash chain + daily Merkle anchoring over the append-only audit
 * log (P1.11 / ADR-0029).
 *
 * Append-only is enforced by RLS; this adds DETECTION in two layers:
 *  - **Chain (P1.11a)** — an async sealer binds each row to its predecessor
 *    (`this_hash = SHA256(canonical | prev)`) within a per-`(tenant, UTC day)`
 *    chain. Catches in-place row tampering.
 *  - **Anchor (P1.11b)** — a daily cron Merkle-roots each closed chain and
 *    writes the root to object storage under Object Lock (WORM). Catches
 *    whole-chain / whole-day replacement and makes a dropped day evident (a
 *    past day with no anchor).
 *
 * The sealer, anchorer, and verifier run privileged (`runPrivileged` →
 * `app.bypass_rls=on`), the only context allowed to UPDATE/INSERT here and to
 * read the tenant-less (`system`) chain.
 */
@Injectable()
export class AuditChainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditChainService.name);
  private readonly enabled: boolean;
  private readonly intervalSec: number;
  private readonly isTest: boolean;
  private readonly anchorEnabled: boolean;
  private readonly anchorBucket: string;
  private readonly anchorLockMode: "GOVERNANCE" | "COMPLIANCE";
  private readonly anchorRetentionDays: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly storage: StorageService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("AUDIT_CHAIN_ENABLED", { infer: true });
    this.intervalSec = config.get("AUDIT_SEAL_INTERVAL_SEC", { infer: true });
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
    this.anchorEnabled = config.get("AUDIT_ANCHOR_ENABLED", { infer: true });
    this.anchorBucket = config.get("AUDIT_ANCHOR_BUCKET", { infer: true });
    this.anchorLockMode = config.get("AUDIT_ANCHOR_LOCK_MODE", { infer: true });
    this.anchorRetentionDays = config.get("AUDIT_ANCHOR_RETENTION_DAYS", {
      infer: true,
    });
  }

  onModuleInit(): void {
    if (!this.enabled || this.intervalSec <= 0 || this.isTest) return;
    this.timer = setInterval(() => {
      void this.sealPendingChains().catch((err) =>
        this.logger.error(
          `audit seal failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, this.intervalSec * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Daily Merkle anchoring of every closed, sealed chain (P1.11b). No-op in
   * tests (driven explicitly) and when disabled.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM, { name: "audit-anchor" })
  async dailyAnchor(): Promise<void> {
    if (!this.enabled || !this.anchorEnabled || this.isTest) return;
    try {
      const { anchored } = await this.anchorClosedChains();
      if (anchored > 0) {
        this.logger.log(`audit: anchored ${anchored} closed chain(s)`);
      }
    } catch (err) {
      this.logger.error(
        `audit anchor cron failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------- chain math ----------

  private scopeOf(tenantId: string | null): string {
    return tenantId ?? AUDIT_SYSTEM_SCOPE;
  }

  private genesis(scope: string, dayStr: string): string {
    return sha256hex(`cmc-audit-genesis:${scope}:${dayStr}`);
  }

  private dayBounds(occurredAt: Date): {
    dayStart: Date;
    dayEnd: Date;
    dayStr: string;
  } {
    const dayStart = new Date(
      Date.UTC(
        occurredAt.getUTCFullYear(),
        occurredAt.getUTCMonth(),
        occurredAt.getUTCDate(),
      ),
    );
    return {
      dayStart,
      dayEnd: new Date(dayStart.getTime() + DAY_MS),
      dayStr: dayStart.toISOString().slice(0, 10),
    };
  }

  private contentHash(row: AuditRow, prevHash: string): string {
    const content = {
      id: row.id,
      seq: row.seq,
      tenantId: row.tenantId,
      actorId: row.actorId,
      actorType: row.actorType,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      outcome: row.outcome,
      ip: row.ip,
      userAgent: row.userAgent,
      requestId: row.requestId,
      traceId: row.traceId,
      metadata: row.metadata ?? null,
      occurredAt: row.occurredAt.toISOString(),
    };
    return sha256hex(`${stableStringify(content)}|${prevHash}`);
  }

  /** Binary Merkle root over ordered leaf hashes (duplicate last leaf if odd). */
  private merkleRoot(leaves: string[]): string {
    if (leaves.length === 0) return sha256hex("cmc-audit-merkle:empty");
    let level = leaves.slice();
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        const right = i + 1 < level.length ? level[i + 1]! : left;
        next.push(sha256hex(`${left}${right}`));
      }
      level = next;
    }
    return level[0]!;
  }

  // ---------- sealing (P1.11a) ----------

  async sealPendingChains(): Promise<AuditSealResponse> {
    if (!this.enabled) return { sealedRows: 0, chainsTouched: 0 };

    return this.tenantDb.runPrivileged(async (tx) => {
      // Serialise sealers cluster-wide (held for this tx, released on commit).
      await tx.execute(sql`select pg_advisory_xact_lock(${SEAL_LOCK_KEY})`);

      const pending = await tx
        .select()
        .from(schema.auditLog)
        .where(isNull(schema.auditLog.thisHash))
        .orderBy(asc(schema.auditLog.seq));

      const runningPrev = new Map<string, string>();
      const touched = new Set<string>();
      let sealedRows = 0;

      for (const row of pending) {
        const scope = this.scopeOf(row.tenantId);
        const { dayStart, dayEnd, dayStr } = this.dayBounds(row.occurredAt);
        const chainKey = `${scope}|${dayStr}`;

        if (!runningPrev.has(chainKey)) {
          const scopeWhere =
            row.tenantId === null
              ? isNull(schema.auditLog.tenantId)
              : eq(schema.auditLog.tenantId, row.tenantId);
          const [head] = await tx
            .select({ thisHash: schema.auditLog.thisHash })
            .from(schema.auditLog)
            .where(
              and(
                scopeWhere,
                gte(schema.auditLog.occurredAt, dayStart),
                lt(schema.auditLog.occurredAt, dayEnd),
                isNotNull(schema.auditLog.thisHash),
              ),
            )
            .orderBy(desc(schema.auditLog.seq))
            .limit(1);
          runningPrev.set(
            chainKey,
            head?.thisHash ?? this.genesis(scope, dayStr),
          );
        }

        const prev = runningPrev.get(chainKey)!;
        const thisHash = this.contentHash(row, prev);
        await tx
          .update(schema.auditLog)
          .set({ prevEventHash: prev, thisHash, sealedAt: new Date() })
          .where(eq(schema.auditLog.id, row.id));

        runningPrev.set(chainKey, thisHash);
        touched.add(chainKey);
        sealedRows++;
      }

      return { sealedRows, chainsTouched: touched.size };
    });
  }

  // ---------- anchoring (P1.11b) ----------

  private toAnchorResponse(
    row: AnchorRow,
    alreadyAnchored: boolean,
  ): AuditAnchorResponse {
    return {
      tenantScope: row.tenantScope,
      date: row.chainDate,
      merkleRoot: row.merkleRoot,
      rowCount: row.rowCount,
      lastSeq: row.lastSeq,
      objectBucket: row.objectBucket,
      objectKey: row.objectKey,
      objectVersionId: row.objectVersionId,
      retainUntil: row.retainUntil ? row.retainUntil.toISOString() : null,
      anchoredAt: row.anchoredAt.toISOString(),
      alreadyAnchored,
    };
  }

  /**
   * Merkle-root a fully-sealed `(tenant, day)` chain and write the root to
   * object storage under Object Lock + record it. Idempotent (returns the
   * existing anchor). Returns null when there's nothing to anchor (no sealed
   * rows, or the chain still has pending rows, or anchoring/storage failed).
   */
  async anchorChain(
    tenantId: string | null,
    dayStr: string,
  ): Promise<AuditAnchorResponse | null> {
    if (!this.anchorEnabled) return null;
    const scope = this.scopeOf(tenantId);
    const dayStart = new Date(`${dayStr}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);

    return this.tenantDb.runPrivileged(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.auditChainAnchor)
        .where(
          and(
            eq(schema.auditChainAnchor.tenantScope, scope),
            eq(schema.auditChainAnchor.chainDate, dayStr),
          ),
        )
        .limit(1);
      if (existing) return this.toAnchorResponse(existing, true);

      const scopeWhere =
        tenantId === null
          ? isNull(schema.auditLog.tenantId)
          : eq(schema.auditLog.tenantId, tenantId);
      const rows = await tx
        .select({
          seq: schema.auditLog.seq,
          thisHash: schema.auditLog.thisHash,
        })
        .from(schema.auditLog)
        .where(
          and(
            scopeWhere,
            gte(schema.auditLog.occurredAt, dayStart),
            lt(schema.auditLog.occurredAt, dayEnd),
          ),
        )
        .orderBy(asc(schema.auditLog.seq));

      const pending = rows.filter((r) => r.thisHash === null).length;
      const sealed = rows.filter((r) => r.thisHash !== null);
      if (sealed.length === 0 || pending > 0) return null;

      const merkleRoot = this.merkleRoot(sealed.map((r) => r.thisHash as string));
      const lastSeq = sealed[sealed.length - 1]!.seq;
      const retainUntil = new Date(
        Date.now() + this.anchorRetentionDays * DAY_MS,
      );
      const objectKey = `anchors/${scope}/${dayStr}.json`;
      const body = JSON.stringify({
        algorithm: "sha256-merkle",
        tenantScope: scope,
        date: dayStr,
        merkleRoot,
        rowCount: sealed.length,
        lastSeq,
        anchoredAt: new Date().toISOString(),
      });

      let versionId: string | null = null;
      try {
        const put = await this.storage.putImmutableObject({
          bucket: this.anchorBucket,
          key: objectKey,
          body,
          lockMode: this.anchorLockMode,
          retainUntil,
        });
        versionId = put.versionId;
      } catch (err) {
        // Don't record an anchor row without the durable WORM object — the
        // cron will retry next run.
        this.logger.error(
          `anchor object write failed for ${scope}/${dayStr}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }

      const [inserted] = await tx
        .insert(schema.auditChainAnchor)
        .values({
          tenantScope: scope,
          chainDate: dayStr,
          merkleRoot,
          rowCount: sealed.length,
          lastSeq,
          objectBucket: this.anchorBucket,
          objectKey,
          objectVersionId: versionId,
          retainUntil,
        })
        .returning();
      return this.toAnchorResponse(inserted!, false);
    });
  }

  /** Seal everything, then anchor every closed (past-day) chain not yet anchored. */
  async anchorClosedChains(): Promise<{ anchored: number }> {
    if (!this.anchorEnabled) return { anchored: 0 };
    await this.sealPendingChains();

    const todayStart = new Date(
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    const chainsRaw = await this.tenantDb.runPrivileged(async (tx) =>
      tx.execute(sql`
        SELECT DISTINCT tenant_id,
               to_char((occurred_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day
          FROM audit_log
         WHERE this_hash IS NOT NULL AND occurred_at < ${todayStart}
      `),
    );
    const chains = chainsRaw as unknown as Array<{
      tenant_id: string | null;
      day: string;
    }>;

    let anchored = 0;
    for (const c of chains) {
      const res = await this.anchorChain(c.tenant_id, c.day);
      if (res && !res.alreadyAnchored) anchored++;
    }
    return { anchored };
  }

  // ---------- verification ----------

  async verifyChain(
    tenantId: string | null,
    dayStr: string,
  ): Promise<AuditChainVerifyResponse> {
    const scope = this.scopeOf(tenantId);
    const dayStart = new Date(`${dayStr}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);

    return this.tenantDb.runPrivileged(async (tx) => {
      const scopeWhere =
        tenantId === null
          ? isNull(schema.auditLog.tenantId)
          : eq(schema.auditLog.tenantId, tenantId);
      const rows = await tx
        .select()
        .from(schema.auditLog)
        .where(
          and(
            scopeWhere,
            gte(schema.auditLog.occurredAt, dayStart),
            lt(schema.auditLog.occurredAt, dayEnd),
          ),
        )
        .orderBy(asc(schema.auditLog.seq));

      const sealed = rows.filter((r) => r.thisHash !== null);
      let prev = this.genesis(scope, dayStr);
      let brokenAtSeq: number | null = null;
      for (const row of sealed) {
        const linkOk = row.prevEventHash === prev;
        const contentOk =
          row.thisHash === this.contentHash(row, row.prevEventHash ?? "");
        if (!linkOk || !contentOk) {
          brokenAtSeq = row.seq;
          break;
        }
        prev = row.thisHash as string;
      }

      // Anchor cross-check: does the day's current root still match the WORM root?
      const [anchor] = await tx
        .select()
        .from(schema.auditChainAnchor)
        .where(
          and(
            eq(schema.auditChainAnchor.tenantScope, scope),
            eq(schema.auditChainAnchor.chainDate, dayStr),
          ),
        )
        .limit(1);
      let anchored = false;
      let anchorRoot: string | null = null;
      let rootMatches: boolean | null = null;
      if (anchor) {
        anchored = true;
        anchorRoot = anchor.merkleRoot;
        const leaves = sealed
          .filter((r) => r.seq <= anchor.lastSeq)
          .map((r) => r.thisHash as string);
        rootMatches =
          leaves.length > 0 && this.merkleRoot(leaves) === anchor.merkleRoot;
      }

      return {
        tenantScope: scope,
        date: dayStr,
        rowsChecked: rows.length,
        sealedRows: sealed.length,
        pendingRows: rows.length - sealed.length,
        valid: brokenAtSeq === null,
        brokenAtSeq,
        anchored,
        anchorRoot,
        rootMatches,
        checkedAt: new Date().toISOString(),
      };
    });
  }
}
