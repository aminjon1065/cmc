ALTER TABLE "folders" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "retention_days" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "legal_hold" boolean DEFAULT false NOT NULL;