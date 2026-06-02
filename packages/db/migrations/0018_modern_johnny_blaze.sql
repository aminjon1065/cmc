-- GIS substrate (P2.7 / ADR-0037). PostGIS must exist before the geometry
-- column type is referenced; the dev image ships it, this makes the test DB
-- self-sufficient (runs as the migration owner / superuser, idempotent).
CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE TABLE "gis_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"kind" varchar(20) DEFAULT 'mixed' NOT NULL,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_uri" varchar(500),
	"is_public" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gis_features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"layer_id" uuid NOT NULL,
	"geometry" geometry(Geometry, 4326) NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "gis_layers" ADD CONSTRAINT "gis_layers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis_layers" ADD CONSTRAINT "gis_layers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis_features" ADD CONSTRAINT "gis_features_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis_features" ADD CONSTRAINT "gis_features_layer_id_gis_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."gis_layers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gis_features" ADD CONSTRAINT "gis_features_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gis_layers_tenant_idx" ON "gis_layers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gis_features_tenant_idx" ON "gis_features" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "gis_features_layer_idx" ON "gis_features" USING btree ("tenant_id","layer_id");--> statement-breakpoint
CREATE INDEX "gis_features_geom_idx" ON "gis_features" USING gist ("geometry");--> statement-breakpoint
-- Row-level security: tenant isolation via the two-GUC pattern (bypass for
-- privileged ops, else tenant_id must match the request's app.tenant_id).
ALTER TABLE "gis_layers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gis_layers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "gis_layers_tenant_isolation" ON "gis_layers"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );--> statement-breakpoint
ALTER TABLE "gis_features" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gis_features" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "gis_features_tenant_isolation" ON "gis_features"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );