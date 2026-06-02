CREATE TABLE "folder_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"subject_type" varchar(10) NOT NULL,
	"subject_id" uuid NOT NULL,
	"access" varchar(10) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "folder_grants" ADD CONSTRAINT "folder_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_grants" ADD CONSTRAINT "folder_grants_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_grants" ADD CONSTRAINT "folder_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folder_grants_subject_uniq" ON "folder_grants" USING btree ("folder_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "folder_grants_folder_idx" ON "folder_grants" USING btree ("tenant_id","folder_id");--> statement-breakpoint
CREATE INDEX "folder_grants_subject_idx" ON "folder_grants" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
-- Tenant isolation (RLS), two-GUC pattern (P3.3b / ADR-0048).
ALTER TABLE "folder_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "folder_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "folder_grants_tenant_isolation" ON "folder_grants"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );