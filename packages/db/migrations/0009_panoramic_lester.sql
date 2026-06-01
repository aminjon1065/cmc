CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"severity" smallint NOT NULL,
	"status" varchar(20) DEFAULT 'reported' NOT NULL,
	"type" varchar(80) NOT NULL,
	"region" varchar(120) NOT NULL,
	"source" varchar(120),
	"summary" varchar(300) NOT NULL,
	"description" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"occurred_at" timestamp with time zone NOT NULL,
	"reported_by" uuid,
	"assigned_to" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_tenant_idx" ON "incidents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "incidents_severity_idx" ON "incidents" USING btree ("tenant_id","severity");--> statement-breakpoint
CREATE INDEX "incidents_occurred_idx" ON "incidents" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "incidents_assigned_idx" ON "incidents" USING btree ("assigned_to");--> statement-breakpoint

-- Severity is 1..5 (1 = most severe). Belt-and-suspenders alongside the zod
-- validation (P1.5 / ADR-0023).
ALTER TABLE "incidents"
  ADD CONSTRAINT "incidents_severity_range" CHECK ("severity" BETWEEN 1 AND 5);--> statement-breakpoint

-- RLS for incidents (P1.5 / ADR-0023). Same two-GUC tenant-isolation pattern
-- as ADR-0003. Incidents are only ever accessed inside an authenticated,
-- tenant-scoped request, so there is no privileged-read path here.
ALTER TABLE "incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incidents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "incidents_tenant_isolation" ON "incidents"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
