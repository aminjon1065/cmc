CREATE TABLE "mfa_backup_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code_hash" varchar(255) NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mfa_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(16) DEFAULT 'totp' NOT NULL,
	"secret_encrypted" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mfa_backup_codes" ADD CONSTRAINT "mfa_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_backup_codes" ADD CONSTRAINT "mfa_backup_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa_methods" ADD CONSTRAINT "user_mfa_methods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa_methods" ADD CONSTRAINT "user_mfa_methods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mfa_backup_codes_user_idx" ON "mfa_backup_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mfa_backup_codes_tenant_idx" ON "mfa_backup_codes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_mfa_methods_user_kind_uq" ON "user_mfa_methods" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "user_mfa_methods_tenant_idx" ON "user_mfa_methods" USING btree ("tenant_id");--> statement-breakpoint

-- RLS for MFA (P1.2 / ADR-0020). Same two-GUC tenant-isolation pattern as
-- ADR-0003. Note: the login mfa-gate reads these tables in a PRIVILEGED
-- (bypass) transaction because it runs before tenant context exists — the
-- bypass branch covers that; authenticated management reads are tenant-scoped.
ALTER TABLE "user_mfa_methods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_mfa_methods" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_mfa_methods_tenant_isolation" ON "user_mfa_methods"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );--> statement-breakpoint

ALTER TABLE "mfa_backup_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mfa_backup_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "mfa_backup_codes_tenant_isolation" ON "mfa_backup_codes"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );