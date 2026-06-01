CREATE TABLE "user_notification_prefs" (
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"email" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_notification_prefs_user_id_kind_pk" PRIMARY KEY("user_id","kind")
);
--> statement-breakpoint
ALTER TABLE "user_notification_prefs" ADD CONSTRAINT "user_notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_prefs" ADD CONSTRAINT "user_notification_prefs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_notification_prefs_tenant_idx" ON "user_notification_prefs" USING btree ("tenant_id");--> statement-breakpoint

-- RLS for user_notification_prefs (P1.6c / ADR-0024). Two-GUC tenant isolation
-- (ADR-0003); the service scopes reads/writes to the user_id on top.
ALTER TABLE "user_notification_prefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_notification_prefs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_notification_prefs_tenant_isolation" ON "user_notification_prefs"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
