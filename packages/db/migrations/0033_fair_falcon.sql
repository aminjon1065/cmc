CREATE TABLE "collab_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collab_docs_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "collab_docs" ADD CONSTRAINT "collab_docs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collab_docs_tenant_idx" ON "collab_docs" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "collab_docs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collab_docs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "collab_docs_tenant_isolation" ON "collab_docs"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );