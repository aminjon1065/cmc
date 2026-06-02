CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"size_bytes" bigint,
	"etag" varchar(128),
	"content_hash" varchar(64),
	"mime_type" varchar(255) NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "current_version_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_doc_no_uniq" ON "document_versions" USING btree ("document_id","version_no");--> statement-breakpoint
CREATE INDEX "document_versions_doc_idx" ON "document_versions" USING btree ("tenant_id","document_id");--> statement-breakpoint
-- Tenant isolation (RLS), two-GUC pattern (P3.4 / ADR-0049).
ALTER TABLE "document_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "document_versions_tenant_isolation" ON "document_versions"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );--> statement-breakpoint
-- Backfill v1 for every existing ready document (P3.4 / ADR-0049).
INSERT INTO document_versions
  (tenant_id, document_id, version_no, storage_key, size_bytes, etag, mime_type, uploaded_by, created_at)
SELECT tenant_id, id, 1, storage_key, size_bytes, etag, mime_type, uploaded_by, created_at
FROM documents
WHERE status = 'ready';