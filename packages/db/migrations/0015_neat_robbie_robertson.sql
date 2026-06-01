CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"aggregate_type" varchar(64) NOT NULL,
	"aggregate_id" varchar(128) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"trace_id" varchar(64),
	"causation_id" uuid,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("seq") WHERE "outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_tenant_idx" ON "outbox" USING btree ("tenant_id","occurred_at");--> statement-breakpoint

-- ---------- outbox RLS (P2.1 / ADR-0031) ----------
-- Mirrors audit_log: inserts are permissive (producers write in the tenant tx;
-- system events carry tenant_id NULL); reads are tenant-scoped or privileged;
-- the relay (privileged) stamps published_at, so UPDATE/DELETE need bypass.
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "outbox_insert" ON "outbox"
  FOR INSERT
  WITH CHECK (true);--> statement-breakpoint

CREATE POLICY "outbox_select" ON "outbox"
  FOR SELECT
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR (
      tenant_id IS NOT NULL
      AND tenant_id::text = current_setting('app.tenant_id', true)
    )
  );--> statement-breakpoint

CREATE POLICY "outbox_no_update" ON "outbox"
  FOR UPDATE
  USING (current_setting('app.bypass_rls', true) = 'on');--> statement-breakpoint

CREATE POLICY "outbox_no_delete" ON "outbox"
  FOR DELETE
  USING (current_setting('app.bypass_rls', true) = 'on');