CREATE TABLE "document_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dims" integer NOT NULL,
	"embedding" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_embeddings" ADD CONSTRAINT "document_embeddings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_embeddings" ADD CONSTRAINT "document_embeddings_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_embeddings_doc_uq" ON "document_embeddings" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_embeddings_tenant_idx" ON "document_embeddings" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "document_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_embeddings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "document_embeddings_tenant_isolation" ON "document_embeddings"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );