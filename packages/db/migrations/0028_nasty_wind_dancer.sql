CREATE TABLE "wiki_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" varchar(300) NOT NULL,
	"content" jsonb DEFAULT '{"type":"doc","content":[]}'::jsonb NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"path" "ltree" NOT NULL,
	"current_version_no" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wiki_page_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"title" varchar(300) NOT NULL,
	"content" jsonb NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_spaces" ADD CONSTRAINT "wiki_spaces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_spaces" ADD CONSTRAINT "wiki_spaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_space_id_wiki_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."wiki_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_parent_id_wiki_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_versions" ADD CONSTRAINT "wiki_page_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_versions" ADD CONSTRAINT "wiki_page_versions_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_versions" ADD CONSTRAINT "wiki_page_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_spaces_tenant_idx" ON "wiki_spaces" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "wiki_pages_tenant_idx" ON "wiki_pages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "wiki_pages_space_idx" ON "wiki_pages" USING btree ("tenant_id","space_id");--> statement-breakpoint
CREATE INDEX "wiki_pages_parent_idx" ON "wiki_pages" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE INDEX "wiki_pages_path_gist" ON "wiki_pages" USING gist ("path");--> statement-breakpoint
CREATE INDEX "wiki_pages_fts_idx" ON "wiki_pages" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("content_text", '')));--> statement-breakpoint
CREATE INDEX "wiki_page_versions_page_idx" ON "wiki_page_versions" USING btree ("tenant_id","page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_page_versions_unique" ON "wiki_page_versions" USING btree ("page_id","version_no");--> statement-breakpoint
ALTER TABLE "wiki_spaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wiki_spaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wiki_spaces_tenant_isolation" ON "wiki_spaces"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
--> statement-breakpoint
ALTER TABLE "wiki_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wiki_pages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wiki_pages_tenant_isolation" ON "wiki_pages"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
--> statement-breakpoint
ALTER TABLE "wiki_page_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wiki_page_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wiki_page_versions_tenant_isolation" ON "wiki_page_versions"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
