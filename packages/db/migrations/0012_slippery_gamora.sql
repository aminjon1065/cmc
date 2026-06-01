ALTER TABLE "audit_log" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "sealed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "audit_log_chain_idx" ON "audit_log" USING btree ("tenant_id","occurred_at","seq");--> statement-breakpoint
CREATE INDEX "audit_log_unsealed_idx" ON "audit_log" USING btree ("seq") WHERE "audit_log"."this_hash" is null;