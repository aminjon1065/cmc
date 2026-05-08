-- Row-Level Security policies enforcing tenant isolation at the database
-- level. Per ADR-0003.
--
-- Two GUCs (Grand Unified Configuration variables) drive the policies:
--   * app.tenant_id   — set by TenantTransactionInterceptor at request entry
--   * app.bypass_rls  — set to 'on' for legitimately cross-tenant code
--                       (login user lookup, refresh token rotation, seed,
--                       compliance tooling)
--
-- The application uses a single Postgres role (`cmc`) which owns the
-- tables. Owners are exempt from RLS by default, so each table also gets
-- FORCE ROW LEVEL SECURITY to make the policies binding for the app role
-- as well. This keeps the deployment simple (one role, one connection
-- pool) without weakening isolation.

-- ---------- users ----------
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_tenant_isolation" ON "users"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
--> statement-breakpoint

-- ---------- sessions ----------
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "sessions_tenant_isolation" ON "sessions"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
--> statement-breakpoint

-- ---------- audit_log ----------
-- Inserts are permissive: anonymous login failures legitimately produce
-- audit rows with tenant_id NULL. Reads are tenant-scoped or privileged.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_insert" ON "audit_log"
  FOR INSERT
  WITH CHECK (true);
--> statement-breakpoint

CREATE POLICY "audit_log_select" ON "audit_log"
  FOR SELECT
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR (
      tenant_id IS NOT NULL
      AND tenant_id::text = current_setting('app.tenant_id', true)
    )
  );
--> statement-breakpoint

-- audit_log is append-only by application convention; reject UPDATE/DELETE
-- from any non-privileged context.
CREATE POLICY "audit_log_no_update" ON "audit_log"
  FOR UPDATE
  USING (current_setting('app.bypass_rls', true) = 'on');
--> statement-breakpoint

CREATE POLICY "audit_log_no_delete" ON "audit_log"
  FOR DELETE
  USING (current_setting('app.bypass_rls', true) = 'on');
--> statement-breakpoint

-- ---------- tenants ----------
-- Deliberately NOT under RLS:
--   * the tenants table is the source of tenant identity, queried before
--     a tenant context exists (login flow, JWT validation);
--   * application code only ever fetches by `id` or `slug` — there is no
--     "list all tenants" path exposed to a tenant user.
-- If a future feature lists tenants for a federated user, add RLS at that
-- point.
