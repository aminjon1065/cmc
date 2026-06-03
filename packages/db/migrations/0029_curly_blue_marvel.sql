CREATE TABLE "wiki_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"parent_id" uuid,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wiki_comments" ADD CONSTRAINT "wiki_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_comments" ADD CONSTRAINT "wiki_comments_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_comments" ADD CONSTRAINT "wiki_comments_parent_id_wiki_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."wiki_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_comments" ADD CONSTRAINT "wiki_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_comments_page_idx" ON "wiki_comments" USING btree ("tenant_id","page_id");--> statement-breakpoint
ALTER TABLE "wiki_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wiki_comments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "wiki_comments_tenant_isolation" ON "wiki_comments"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
