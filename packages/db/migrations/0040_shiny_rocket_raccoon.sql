ALTER TABLE "incidents" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_region_idx" ON "incidents" USING btree ("tenant_id","region_id");--> statement-breakpoint
CREATE INDEX "cases_region_idx" ON "cases" USING btree ("tenant_id","region_id");