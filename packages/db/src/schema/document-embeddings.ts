import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { documents } from "./documents";

/**
 * Document embeddings (P5.2 / ADR-0068). One vector per document, generated via
 * the LLM gateway (P5.1) and stored in Postgres as a JSON number[] — no pgvector
 * extension needed (the ANN index / Qdrant is a scale follow-on). Tenant-
 * isolated via RLS; cascades with the document. Unique per document (upsert).
 */
export const documentEmbeddings = pgTable(
  "document_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    dims: integer("dims").notNull(),
    /** The embedding vector as a JSON number[] (pgvector ANN = follow-on). */
    embedding: jsonb("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    docUq: uniqueIndex("document_embeddings_doc_uq").on(t.documentId),
    tenantIdx: index("document_embeddings_tenant_idx").on(t.tenantId),
  }),
);

export type DocumentEmbedding = typeof documentEmbeddings.$inferSelect;
export type NewDocumentEmbedding = typeof documentEmbeddings.$inferInsert;
