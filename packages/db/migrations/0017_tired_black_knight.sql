CREATE TABLE "projection_cursors" (
	"consumer" varchar(64) PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
