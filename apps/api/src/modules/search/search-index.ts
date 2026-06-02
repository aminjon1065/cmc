import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";

/** DI token for the OpenSearch document index (P3.6 / ADR-0051). */
export const SEARCH_INDEX = Symbol("SEARCH_INDEX");

/** A document as indexed for search. Mirrors the searchable document fields. */
export interface IndexedDocument {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  mimeType: string;
  folderId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** A search hit (P3.6b uses this). */
export interface SearchHit {
  id: string;
  folderId: string | null;
  score: number;
}

/**
 * Thin OpenSearch seam — faked in tests; the real driver is loaded only when
 * `OPENSEARCH_ENABLED`. Mirrors the ClickHouse client seam (P2.5).
 */
export interface SearchIndex {
  readonly active: boolean;
  /** Create the documents index + mapping if absent (idempotent). */
  ensureIndex(): Promise<void>;
  indexDocument(doc: IndexedDocument): Promise<void>;
  deleteDocument(tenantId: string, id: string): Promise<void>;
  /** Tenant-scoped full-text search over name + description (P3.6b). */
  search(
    tenantId: string,
    query: string,
    limit: number,
  ): Promise<SearchHit[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Disabled index — the indexer idles; Postgres FTS remains the search. */
export class NoopSearchIndex implements SearchIndex {
  readonly active = false;
  async ensureIndex(): Promise<void> {}
  async indexDocument(): Promise<void> {}
  async deleteDocument(): Promise<void> {}
  async search(): Promise<SearchHit[]> {
    return [];
  }
  async ping(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {}
}

/**
 * Factory: a real OpenSearch-backed index when `OPENSEARCH_ENABLED`, else the
 * noop. `@opensearch-project/opensearch` is dynamic-imported so it never enters
 * the jest runtime (the gated-lazy-seam pattern).
 */
export async function createSearchIndex(
  config: ConfigService<AppConfig, true>,
): Promise<SearchIndex> {
  if (!config.get("OPENSEARCH_ENABLED", { infer: true })) {
    return new NoopSearchIndex();
  }
  const { RealSearchIndex } = await import("./search-index.impl");
  return RealSearchIndex.create({
    url: config.get("OPENSEARCH_URL", { infer: true }),
    indexPrefix: config.get("OPENSEARCH_INDEX_PREFIX", { infer: true }),
  });
}
