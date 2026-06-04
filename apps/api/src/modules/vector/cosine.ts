/**
 * Cosine similarity over two equal-length numeric vectors (P5.3 / ADR-0069).
 *
 * Pure + dependency-free so it is unit-testable and runs in the request path
 * without pgvector — this is the brute-force kNN scorer for semantic search
 * (the pgvector ANN index / Qdrant is the scale follow-on from P5.2 / ADR-0068).
 *
 * Returns the cosine of the angle between the vectors, in `[-1, 1]` (higher =
 * more similar). Returns `0` for the non-comparable cases — mismatched lengths
 * or a zero-magnitude vector — so a bad/empty embedding can never rank above a
 * real match (cosine of real embeddings is typically positive).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Guard against NaN/±Infinity from non-finite inputs.
  return Number.isFinite(sim) ? sim : 0;
}
