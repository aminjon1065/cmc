CREATE TABLE "audit_export_cursor" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
