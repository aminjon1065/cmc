import { Client } from "@opensearch-project/opensearch";
import type { IndexedDocument, SearchHit, SearchIndex } from "./search-index";

type Opts = { url: string; indexPrefix: string };

/**
 * Real OpenSearch-backed document index (P3.6 / ADR-0051). Loaded via dynamic
 * import from the factory only when `OPENSEARCH_ENABLED`, so the driver never
 * enters jest. `refresh: true` on writes keeps the index read-your-writes (fine
 * at this scale; a prod tuning could relax it).
 */
export class RealSearchIndex implements SearchIndex {
  readonly active = true;

  private constructor(
    private readonly client: Client,
    private readonly index: string,
  ) {}

  static async create(opts: Opts): Promise<RealSearchIndex> {
    const client = new Client({ node: opts.url });
    return new RealSearchIndex(client, `${opts.indexPrefix}-documents`);
  }

  async ensureIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: this.index });
    if (exists.body) return;
    await this.client.indices.create({
      index: this.index,
      body: {
        mappings: {
          properties: {
            tenantId: { type: "keyword" },
            name: { type: "text" },
            description: { type: "text" },
            mimeType: { type: "keyword" },
            folderId: { type: "keyword" },
            status: { type: "keyword" },
            createdAt: { type: "date" },
            updatedAt: { type: "date" },
            content: { type: "text" },
          },
        },
      },
    });
  }

  async indexDocument(doc: IndexedDocument): Promise<void> {
    await this.client.index({
      index: this.index,
      id: doc.id,
      body: {
        tenantId: doc.tenantId,
        name: doc.name,
        description: doc.description,
        mimeType: doc.mimeType,
        folderId: doc.folderId,
        status: doc.status,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        content: doc.content ?? null,
      },
      refresh: true,
    });
  }

  async deleteDocument(_tenantId: string, id: string): Promise<void> {
    try {
      await this.client.delete({ index: this.index, id, refresh: true });
    } catch (err) {
      const status = (err as { meta?: { statusCode?: number } })?.meta
        ?.statusCode;
      if (status !== 404) throw err; // already gone is fine
    }
  }

  async search(
    tenantId: string,
    query: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const res = await this.client.search({
      index: this.index,
      body: {
        size: limit,
        query: {
          bool: {
            filter: [{ term: { tenantId } }],
            must: [
              {
                multi_match: {
                  query,
                  fields: ["name^2", "description", "content"],
                },
              },
            ],
          },
        },
      },
    });
    const hits = (res.body?.hits?.hits ?? []) as unknown as Array<{
      _id: string;
      _score: number | null;
      _source?: { folderId?: string | null };
    }>;
    return hits.map((h) => ({
      id: h._id,
      folderId: h._source?.folderId ?? null,
      score: h._score ?? 0,
    }));
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.client.ping();
      return r.statusCode === 200;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
