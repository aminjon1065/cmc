CREATE TABLE "video_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"egress_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"s3_key" text NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "video_recordings" ADD CONSTRAINT "video_recordings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_recordings" ADD CONSTRAINT "video_recordings_room_id_video_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."video_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_recordings" ADD CONSTRAINT "video_recordings_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "video_recordings_room_idx" ON "video_recordings" USING btree ("tenant_id","room_id");--> statement-breakpoint
ALTER TABLE "video_recordings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "video_recordings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "video_recordings_tenant_isolation" ON "video_recordings"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );