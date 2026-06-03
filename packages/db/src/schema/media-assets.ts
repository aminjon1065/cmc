import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";
import { documents } from "./documents";

/**
 * Media assets (P4.5 / ADR-0063). A streamable derivative of an uploaded
 * document: a gated FFmpeg worker transcodes the source to HLS and writes the
 * playlist + segments to S3 under `media/<tenant>/<assetId>/`. `playlist_key` is
 * the `.m3u8` object key; the browser plays it through the BFF stream proxy.
 * Tenant-isolated via RLS.
 */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** `video` | `audio`. */
    kind: text("kind").notNull().default("video"),
    /** `pending` | `processing` | `ready` | `failed`. */
    status: text("status").notNull().default("pending"),
    /** HLS playlist (.m3u8) S3 key once ready. */
    playlistKey: text("playlist_key"),
    /** Poster/thumbnail S3 key. */
    posterKey: text("poster_key"),
    /** Optional text watermark burned into the transcode (P4.5c). */
    watermark: text("watermark"),
    durationSec: integer("duration_sec"),
    error: text("error"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    docIdx: index("media_assets_doc_idx").on(t.tenantId, t.documentId),
    statusIdx: index("media_assets_status_idx").on(t.tenantId, t.status),
  }),
);

export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
