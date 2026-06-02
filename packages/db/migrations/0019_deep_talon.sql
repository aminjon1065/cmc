CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" varchar(300) NOT NULL,
	"description" text,
	"type" varchar(80) NOT NULL,
	"priority" smallint DEFAULT 3 NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"opened_by" uuid,
	"due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "case_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" varchar(30) NOT NULL,
	"body" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gis_features" ALTER COLUMN "geometry" SET DATA TYPE geometry(Geometry, 4326);--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_activity" ADD CONSTRAINT "case_activity_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_activity" ADD CONSTRAINT "case_activity_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_activity" ADD CONSTRAINT "case_activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cases_tenant_idx" ON "cases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cases_status_idx" ON "cases" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "cases_assigned_idx" ON "cases" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "cases_due_idx" ON "cases" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "case_activity_tenant_idx" ON "case_activity" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "case_activity_case_idx" ON "case_activity" USING btree ("tenant_id","case_id");--> statement-breakpoint
CREATE INDEX "case_activity_created_idx" ON "case_activity" USING btree ("created_at");--> statement-breakpoint
-- Priority bound (1..5) — defence in depth on top of the Zod contract.
ALTER TABLE "cases" ADD CONSTRAINT "cases_priority_check" CHECK ("priority" BETWEEN 1 AND 5);--> statement-breakpoint
-- Row-level security: tenant isolation (two-GUC pattern), like incidents.
ALTER TABLE "cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cases_tenant_isolation" ON "cases"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );--> statement-breakpoint
ALTER TABLE "case_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_activity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_activity_tenant_isolation" ON "case_activity"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );