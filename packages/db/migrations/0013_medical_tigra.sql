CREATE TABLE "audit_chain_anchor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_scope" varchar(64) NOT NULL,
	"chain_date" date NOT NULL,
	"merkle_root" varchar(128) NOT NULL,
	"row_count" integer NOT NULL,
	"last_seq" bigint NOT NULL,
	"object_bucket" varchar(128) NOT NULL,
	"object_key" varchar(256) NOT NULL,
	"object_version_id" varchar(128),
	"retain_until" timestamp with time zone,
	"anchored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_chain_anchor_scope_date_idx" ON "audit_chain_anchor" USING btree ("tenant_scope","chain_date");--> statement-breakpoint

-- ---------- audit_chain_anchor RLS (P1.11b / ADR-0029) ----------
-- Append-only integrity index, mirroring audit_log: privileged code (the
-- anchor service, via app.bypass_rls) writes; a tenant reads only its own
-- anchors; UPDATE/DELETE are denied to non-privileged contexts.
ALTER TABLE "audit_chain_anchor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_chain_anchor" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "audit_chain_anchor_select" ON "audit_chain_anchor"
  FOR SELECT
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR tenant_scope = current_setting('app.tenant_id', true)
  );--> statement-breakpoint

CREATE POLICY "audit_chain_anchor_insert" ON "audit_chain_anchor"
  FOR INSERT
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint

CREATE POLICY "audit_chain_anchor_no_update" ON "audit_chain_anchor"
  FOR UPDATE
  USING (current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint

CREATE POLICY "audit_chain_anchor_no_delete" ON "audit_chain_anchor"
  FOR DELETE
  USING (current_setting('app.bypass_rls', true) = 'on');