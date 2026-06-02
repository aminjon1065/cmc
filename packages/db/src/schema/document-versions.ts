import {
  bigint,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { documents } from "./documents";
import { users } from "./users";

/**
 * Immutable per-version snapshot of a document's bytes (P3.4 / ADR-0049). Every
 * document has at least v1 (created at first finalize; pre-existing docs are
 * backfilled). `documents.current_version_no` points at the live one and the
 * document row denormalises that version's storage_key/etag/size so the download
 * path is unchanged. `content_hash` is a best-effort SHA-256 (size-capped) for
 * integrity + identical-content detection. Tenant-isolated via RLS.
 */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    storageKey: varchar("storage_key", { length: 512 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    etag: varchar("etag", { length: 128 }),
    /** SHA-256 hex of the bytes; null when over the hash size cap. */
    contentHash: varchar("content_hash", { length: 64 }),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqueVersion: uniqueIndex("document_versions_doc_no_uniq").on(
      t.documentId,
      t.versionNo,
    ),
    docIdx: index("document_versions_doc_idx").on(t.tenantId, t.documentId),
  }),
);

export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;
