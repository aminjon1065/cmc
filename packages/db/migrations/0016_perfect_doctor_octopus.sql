CREATE TABLE "consumed_events" (
	"event_id" uuid NOT NULL,
	"consumer" varchar(64) NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumed_events_event_id_consumer_pk" PRIMARY KEY("event_id","consumer")
);
