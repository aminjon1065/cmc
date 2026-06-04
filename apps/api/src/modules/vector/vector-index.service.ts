import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { LLM_PROVIDER, type LlmProvider } from "../llm/llm.provider";
import { cosineSimilarity } from "./cosine";
import type { AppConfig } from "../../config/configuration";

type DocLike = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  /** Extracted full text (P5.6) — embedded alongside name/description when present. */
  content?: string | null;
};

/**
 * Document embedding pipeline (P5.2 / ADR-0068). Embeds documents via the LLM
 * gateway (P5.1) and stores the vector in Postgres (`document_embeddings`).
 * Gated by `VECTOR_ENABLED` AND the LLM provider being active, so it's a no-op
 * in dev/test/CI (the provider is a noop there). Indexing rides the document
 * finalize/delete flow (best-effort, mirroring the OpenSearch indexer P3.6);
 * `reindexAll` backfills. Semantic search over these vectors is P5.3.
 */
@Injectable()
export class VectorIndexService {
  private readonly logger = new Logger(VectorIndexService.name);
  private readonly vectorEnabled: boolean;
  private readonly embedModel: string;

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly tenantDb: TenantDatabaseService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.vectorEnabled = config.get("VECTOR_ENABLED", { infer: true });
    this.embedModel = config.get("LLM_EMBED_MODEL", { infer: true });
  }

  /** Embedding is active only when enabled AND the LLM provider is up. */
  get active(): boolean {
    return this.vectorEnabled && this.provider.active;
  }

  private textOf(doc: DocLike): string {
    return [doc.name, doc.description, doc.content]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 8000);
  }

  /** Embed a document + upsert its vector. Throws on failure (caller best-efforts). */
  async indexDocument(doc: DocLike): Promise<void> {
    if (!this.active) return;
    const { embeddings, model } = await this.provider.embed(
      [this.textOf(doc)],
      this.embedModel,
    );
    const vec = embeddings[0] ?? [];
    if (vec.length === 0) return;
    await this.tenantDb.run((tx) =>
      tx
        .insert(schema.documentEmbeddings)
        .values({
          tenantId: doc.tenantId,
          documentId: doc.id,
          model,
          dims: vec.length,
          embedding: vec,
        })
        .onConflictDoUpdate({
          target: schema.documentEmbeddings.documentId,
          set: { model, dims: vec.length, embedding: vec, updatedAt: sql`now()` },
        }),
    );
  }

  /** Remove a document's embedding (no gate — clears stale rows on delete). */
  async removeDocument(id: string): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .delete(schema.documentEmbeddings)
        .where(eq(schema.documentEmbeddings.documentId, id)),
    );
  }

  /**
   * Semantic kNN for federated search (P5.3 / ADR-0069): embed the query via the
   * LLM gateway, then **brute-force cosine** over this tenant's stored vectors
   * (RLS-scoped) and return the top-`cap` document ids with their similarity —
   * symmetric with the OpenSearch lane (`{id, score}[]`), so the search service
   * hydrates + folder-access-filters them through the same path. Returns `[]`
   * when inactive or the query is empty (search degrades to keyword-only). Only
   * equal-dimension vectors are compared (stale dims after a model change are
   * skipped until re-embedded), and non-positive scores are dropped so an
   * unrelated/empty embedding never surfaces. Brute-force is fine at single-site
   * scale; the pgvector ANN index swaps in here without touching the caller.
   */
  async similar(
    query: string,
    cap: number,
  ): Promise<{ id: string; score: number }[]> {
    if (!this.active) return [];
    const q = query.trim();
    if (q.length === 0) return [];
    const { embeddings } = await this.provider.embed([q], this.embedModel);
    const qv = embeddings[0] ?? [];
    if (qv.length === 0) return [];
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select({
          id: schema.documentEmbeddings.documentId,
          embedding: schema.documentEmbeddings.embedding,
        })
        .from(schema.documentEmbeddings),
    );
    return rows
      .map((r) => ({
        id: r.id,
        score: cosineSimilarity(qv, r.embedding as number[]),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, Math.max(1, Math.trunc(cap)));
  }

  /** Re-embed every finalized (`ready`) document in the tenant. Returns the count. */
  async reindexAll(): Promise<number> {
    if (!this.active) return 0;
    const docs = await this.tenantDb.run((tx) =>
      tx
        .select({
          id: schema.documents.id,
          tenantId: schema.documents.tenantId,
          name: schema.documents.name,
          description: schema.documents.description,
        })
        .from(schema.documents)
        .where(
          and(
            isNull(schema.documents.deletedAt),
            eq(schema.documents.status, "ready"),
          ),
        ),
    );
    let n = 0;
    for (const d of docs) {
      try {
        await this.indexDocument(d);
        n++;
      } catch (err) {
        this.logger.warn(
          `reindex embed failed for ${d.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return n;
  }

  async status(): Promise<{ active: boolean; indexed: number }> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select({ c: sql<number>`count(*)::int` })
        .from(schema.documentEmbeddings),
    );
    return { active: this.active, indexed: rows[0]?.c ?? 0 };
  }
}
