import type { RagCitation, SearchResult } from "@cmc/contracts";

/** A retrieved/anchored source, numbered for `[n]` citation. */
export type GroundingSource = {
  n: number;
  type: SearchResult["type"];
  id: string;
  title: string;
};

/**
 * Shared grounding helpers for the RAG (P5.4) + copilot (P5.5) compose paths.
 * Pure + dependency-free so both services build identical, citable context and
 * resolve citations the same way.
 */

/**
 * Build a numbered context from hits' available text (`title + snippet` —
 * documents are name+description until full-content extraction in P5.6), bounded
 * by a per-source + total character budget so a long tail can't blow the prompt.
 * Hits are taken in order (best-first); pass anchored records first to pin them.
 */
export function assembleContext(
  hits: SearchResult[],
  charBudget: number,
): { sources: GroundingSource[]; contextText: string } {
  const perSourceCap = Math.max(
    400,
    Math.ceil(charBudget / Math.max(1, hits.length)),
  );
  const sources: GroundingSource[] = [];
  const blocks: string[] = [];
  let used = 0;
  for (const h of hits) {
    const n = sources.length + 1;
    const body = [h.title, h.snippet].filter(Boolean).join(" — ");
    const block = `[${n}] (${h.type}) ${body}`.slice(0, perSourceCap);
    if (used + block.length > charBudget && sources.length > 0) break;
    used += block.length;
    sources.push({ n, type: h.type, id: h.id, title: h.title });
    blocks.push(block);
  }
  return { sources, contextText: blocks.join("\n\n") };
}

/** Parse `[n]` markers → distinct, in-range sources (1-based), in citation order. */
export function resolveCitations(
  answer: string,
  sources: GroundingSource[],
): RagCitation[] {
  const seen = new Set<number>();
  const out: RagCitation[] = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number.parseInt(m[1]!, 10);
    if (seen.has(n)) continue;
    seen.add(n);
    const src = sources.find((s) => s.n === n);
    if (src) out.push({ type: src.type, id: src.id, title: src.title });
  }
  return out;
}
