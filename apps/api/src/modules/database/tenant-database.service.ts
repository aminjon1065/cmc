import { Inject, Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import type { Database } from "@cmc/db";
import { DB } from "./database.tokens";

/**
 * The Drizzle transaction handle as exposed inside `db.transaction(...)`.
 * We type it loosely as the runtime shape of the root db; Drizzle's tx
 * exposes the same query API so callers can use the same fluent builder.
 */
export type TenantTx = Parameters<
  Parameters<Database["db"]["transaction"]>[0]
>[0];

/**
 * Per-request database access wrapper that enforces tenant scope at the
 * Postgres level. Every call goes through a transaction in which we
 * `SET LOCAL app.tenant_id` so RLS policies on tenant-scoped tables can
 * filter rows automatically.
 *
 * Usage from a service:
 *   await this.tenantDb.run(tx => tx.select().from(users)...);
 *
 * The interceptor (`TenantTransactionInterceptor`) opens a transaction at
 * request entry and stores it in ALS so a single request reuses one tx —
 * `run()` then re-enters the same tx instead of opening nested savepoints.
 */
@Injectable()
export class TenantDatabaseService {
  private readonly logger = new Logger(TenantDatabaseService.name);
  private readonly txStorage = new AsyncLocalStorage<TenantTx>();

  constructor(@Inject(DB) private readonly database: Database) {}

  /**
   * Returns the currently active transaction, or undefined if not inside
   * a tenant-scoped block. Services should prefer `run()` rather than
   * reading this directly.
   */
  getCurrentTx(): TenantTx | undefined {
    return this.txStorage.getStore();
  }

  /**
   * Run `fn` inside the active tenant transaction. If we're already inside
   * one (set by the request interceptor), re-use it; otherwise the caller
   * must wrap in `runForTenant()` first — `run()` alone is not allowed
   * outside a request context.
   */
  async run<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const tx = this.txStorage.getStore();
    if (!tx) {
      throw new Error(
        "TenantDatabaseService.run() called outside a tenant scope. " +
          "Wrap the work in runForTenant(...) or runPrivileged(...).",
      );
    }
    return fn(tx);
  }

  /**
   * Open a new tenant-scoped transaction with `SET LOCAL app.tenant_id`.
   * The interceptor uses this for HTTP requests; background jobs and
   * tests call this directly to enter tenant scope without going through
   * an HTTP handler.
   */
  async runForTenant<T>(
    tenantId: string,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL app.tenant_id = '${tenantId}'`));
      return this.txStorage.run(tx, () => fn(tx));
    });
  }

  /**
   * Open a transaction that bypasses RLS. Used for legitimately
   * cross-tenant operations: cross-tenant user lookup during login,
   * platform-admin tooling, integration jobs.
   *
   * The bypass is enforced by the RLS policies themselves — they all
   * include an `OR current_setting('app.bypass_rls', true) = 'on'` clause.
   * Audit-log every use of this path; it is a privileged operation.
   *
   * Footgun avoidance: `SET LOCAL` inside a Postgres subtransaction
   * persists into the outer transaction once the subtransaction commits.
   * If a logged-in request runs `runPrivileged` (e.g. an authenticated
   * user hitting /auth/login), the bypass would leak into the rest of
   * the request. The `try/finally` resets it to 'off' before returning.
   */
  async runPrivileged<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL app.bypass_rls = 'on'`));
      try {
        return await this.txStorage.run(tx, () => fn(tx));
      } finally {
        try {
          await tx.execute(sql.raw(`SET LOCAL app.bypass_rls = 'off'`));
        } catch {
          // Tx may already be aborted on the error path; nothing to do.
        }
      }
    });
  }

  /**
   * Escape hatch for bootstrap code (seed, migrations) that runs outside
   * any tenant or request context and needs the raw root client. Logged
   * loudly because misuse is a security issue.
   */
  unsafeRoot(): Database["db"] {
    this.logger.warn(
      "TenantDatabaseService.unsafeRoot() invoked — this bypasses RLS entirely. " +
        "Only legitimate uses are bootstrap scripts and migrations.",
    );
    return this.database.db;
  }
}
