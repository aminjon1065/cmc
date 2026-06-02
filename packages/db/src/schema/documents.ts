import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { users } from "./users";
import { folders } from "./folders";

/**
 * A `documents` row is the metadata record for one uploaded artifact.
 *
 * Lifecycle:
 *   `uploading` → `ready`              (happy path, finalised after S3 PUT)
 *   `uploading` → `failed`              (PUT failed / abandoned)
 *   `ready`     → soft delete            (deleted_at set; row retained)
 *
 * Why a row exists *before* the bytes do: the API issues a pre-signed PUT
 * URL targeting `storage_key`, then the browser PUTs the file directly to
 * MinIO. Pre-allocating the row gives us a stable id to embed in the
 * storage key and an audit point for abandoned uploads.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    /** Original filename as supplied by the uploader. Display only. */
    name: varchar("name", { length: 512 }).notNull(),
    /** Optional human description; indexed by tsvector for search. */
    description: text("description"),

    /** MIME type the uploader claims; we don't sniff bytes (yet). */
    mimeType: varchar("mime_type", { length: 255 }).notNull(),

    /** Size declared at upload-init; cross-checked on finalize. */
    sizeBytes: bigint("size_bytes", { mode: "number" }),

    /** S3/MinIO bucket and object key — the byte address. */
    storageBucket: varchar("storage_bucket", { length: 128 }).notNull(),
    storageKey: varchar("storage_key", { length: 512 }).notNull(),

    /** ETag returned by MinIO on PUT — captured during finalize. */
    etag: varchar("etag", { length: 128 }),

    /** 'uploading' | 'ready' | 'failed' */
    status: varchar("status", { length: 16 }).notNull().default("uploading"),

    /** Live version number; the row denormalises that version's bytes (P3.4). */
    currentVersionNo: integer("current_version_no").notNull().default(1),

    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    /** Folder this document is filed in; null = unfiled (P3.3 / ADR-0047). */
    folderId: uuid("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),

    /** Retention override in days; null = inherit the folder policy (P3.5). */
    retentionDays: integer("retention_days"),
    /** When true, retention + manual deletion are suspended (P3.5 / ADR-0050). */
    legalHold: boolean("legal_hold").notNull().default(false),

    /** Free-form structured metadata; future modules add typed schemas. */
    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantCreatedIdx: index("documents_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    tenantStatusIdx: index("documents_tenant_status_idx").on(
      t.tenantId,
      t.status,
    ),
    uploadedByIdx: index("documents_uploaded_by_idx").on(t.uploadedBy),
    // Full-text search (P2.11 / ADR-0041).
    ftsIdx: index("documents_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${t.name}, '') || ' ' || coalesce(${t.description}, ''))`,
    ),
  }),
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
