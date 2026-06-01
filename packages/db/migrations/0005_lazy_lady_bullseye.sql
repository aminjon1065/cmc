CREATE TABLE "tenant_branding" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"locale_default" varchar(12) DEFAULT 'en' NOT NULL,
	"logo_url" varchar(1024),
	"copy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Tenant isolation for tenant_branding (P0.11 / ADR-0018). Same two-GUC
-- pattern as ADR-0003: `app.tenant_id` scopes a tenant to its own row;
-- `app.bypass_rls` lets privileged paths read any row (the anonymous
-- pre-auth branding lookup resolves the default tenant via bypass).
-- FORCE makes the table owner subject to the policy too.
ALTER TABLE "tenant_branding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_branding" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_branding_tenant_isolation" ON "tenant_branding"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );