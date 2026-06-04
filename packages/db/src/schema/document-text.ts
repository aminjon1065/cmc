import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { documents } from "./documents";

/**
 * Extracted document text (P5.6 / ADR-0072). One row per document holding the
 * full-text pulled by the document-intelligence pipeline (PDF text-layer or
 * Tesseract OCR for scans/images). Sidecar table (not a column on `documents`)
 * so the large `content` never bloats document list/get queries; Postgres TOASTs
 * it out-of-line. Tenant-isolated via RLS; cascades with the document. Unique per
 * document (upsert on re-extract). Feeds OpenSearch `content` + the P5.2
 * embedding re-index so semantic search / RAG / copilots gain real content.
 */
export const documentText = pgTable(
  "document_text",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** The extracted plain text (capped at DOC_EXTRACT_MAX_CHARS). */
    content: text("content").notNull(),
    charCount: integer("char_count").notNull(),
    /** `done` (text found) | `empty` (extracted, no text). */
    status: text("status").notNull().default("done"),
    extractedAt: timestamp("extracted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    docUq: uniqueIndex("document_text_doc_uq").on(t.documentId),
    tenantIdx: index("document_text_tenant_idx").on(t.tenantId),
  }),
);

export type DocumentText = typeof documentText.$inferSelect;
export type NewDocumentText = typeof documentText.$inferInsert;
