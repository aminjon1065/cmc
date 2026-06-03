import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";
import { videoRooms } from "./video-rooms";

/**
 * Video-room recordings (P4.2c / ADR-0061). One row per LiveKit egress run
 * (manual start/stop). The egress service composites the room and uploads an
 * MP4 to S3/MinIO at `s3_key`; `egress_id` is LiveKit's handle (used to stop).
 * Tenant-isolated via RLS.
 */
export const videoRecordings = pgTable(
  "video_recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    roomId: uuid("room_id")
      .notNull()
      .references(() => videoRooms.id, { onDelete: "cascade" }),
    /** LiveKit egress id (handle for stopEgress); set once egress starts. */
    egressId: text("egress_id"),
    /** `active` (recording) | `complete` | `failed`. */
    status: text("status").notNull().default("active"),
    /** S3 object key the egress uploads the MP4 to. */
    s3Key: text("s3_key").notNull(),
    startedBy: uuid("started_by").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => ({
    roomIdx: index("video_recordings_room_idx").on(t.tenantId, t.roomId),
  }),
);

export type VideoRecording = typeof videoRecordings.$inferSelect;
export type NewVideoRecording = typeof videoRecordings.$inferInsert;
