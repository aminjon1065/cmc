import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * Video-conference rooms (P4.2 / ADR-0061). Our metadata for a LiveKit room;
 * the actual SFU room is auto-created by LiveKit when the first participant
 * joins with a room-scoped token, so this row can exist without a running
 * LiveKit. `livekit_room` is the globally-unique SFU room name. Standalone
 * today, but `linked_type`/`linked_id` are reserved so a room can later be
 * attached to an incident/case ("start a call on this incident"). Tenant-
 * isolated via RLS.
 */
export const videoRooms = pgTable(
  "video_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Human-facing room title. */
    name: text("name").notNull(),
    /** Globally-unique LiveKit SFU room name (the token's `room` grant). */
    livekitRoom: text("livekit_room").notNull().unique(),
    /** `open` (joinable) | `closed`. */
    status: text("status").notNull().default("open"),
    /** Reserved: domain entity this room belongs to (e.g. `incident`/`case`). */
    linkedType: text("linked_type"),
    linkedId: uuid("linked_id"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => ({
    tenantStatusIdx: index("video_rooms_tenant_status_idx").on(
      t.tenantId,
      t.status,
    ),
    linkIdx: index("video_rooms_link_idx").on(
      t.tenantId,
      t.linkedType,
      t.linkedId,
    ),
  }),
);

export type VideoRoom = typeof videoRooms.$inferSelect;
export type NewVideoRoom = typeof videoRooms.$inferInsert;
