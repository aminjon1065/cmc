-- Tenant isolation for the documents table. Same pattern as ADR-0003:
-- two GUCs (`app.tenant_id`, `app.bypass_rls`) drive the policy; FORCE
-- ROW LEVEL SECURITY makes the table owner subject to the policy too.

ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;

CREATE POLICY "documents_tenant_isolation" ON "documents"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
