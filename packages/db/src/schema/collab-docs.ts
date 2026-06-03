import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/** Raw bytes column for the encoded Y.Doc state (Yjs update). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Realtime-collaboration documents (P4.1 / ADR-0060). One row per Hocuspocus
 * document `name` (e.g. `wiki.<pageId>`) holding the encoded Y.Doc state. This
 * is the authoritative live state during collaborative editing; the Hocuspocus
 * `onStoreDocument` hook also debounce-snapshots it back to the owning domain
 * row (e.g. `wiki_pages.content` + derived plaintext) so search / non-collab
 * reads / version history keep working. Tenant-isolated via RLS.
 */
export const collabDocs = pgTable(
  "collab_docs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Hocuspocus document name — globally unique (domain-prefixed entity id). */
    name: text("name").notNull().unique(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** `Y.encodeStateAsUpdate(doc)` bytes. */
    state: bytea("state").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("collab_docs_tenant_idx").on(t.tenantId),
  }),
);

export type CollabDoc = typeof collabDocs.$inferSelect;
export type NewCollabDoc = typeof collabDocs.$inferInsert;
