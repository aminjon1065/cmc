CREATE TABLE "document_text" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"content" text NOT NULL,
	"char_count" integer NOT NULL,
	"status" text DEFAULT 'done' NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_text" ADD CONSTRAINT "document_text_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_text" ADD CONSTRAINT "document_text_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_text_doc_uq" ON "document_text" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_text_tenant_idx" ON "document_text" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "document_text" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_text" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "document_text_tenant_isolation" ON "document_text"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_id::text = current_setting('app.tenant_id', true)
  );
