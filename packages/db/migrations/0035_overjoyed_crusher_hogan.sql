CREATE TABLE "video_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"livekit_room" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"linked_type" text,
	"linked_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "video_rooms_livekit_room_unique" UNIQUE("livekit_room")
);
--> statement-breakpoint
ALTER TABLE "video_rooms" ADD CONSTRAINT "video_rooms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_rooms" ADD CONSTRAINT "video_rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_rooms_tenant_status_idx" ON "video_rooms" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "video_rooms_link_idx" ON "video_rooms" USING btree ("tenant_id","linked_type","linked_id");--> statement-breakpoint
ALTER TABLE "video_rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "video_rooms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "video_rooms_tenant_isolation" ON "video_rooms"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );