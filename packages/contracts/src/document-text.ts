import { z } from "zod";

/**
 * Document text extraction (P5.6 / ADR-0072). The document-intelligence pipeline
 * pulls full text from a document (PDF text-layer or Tesseract OCR) into the
 * `document_text` sidecar, which then feeds OpenSearch `content` + the P5.2
 * embedding re-index. `POST /v1/documents/:id/extract` runs it; `GET
 * /v1/documents/:id/text` reads the result. Gated by `DOC_EXTRACT_ENABLED`
 * (503 when off); the real OCR toolchain is a sovereign/on-prem live boundary.
 */

export const DOC_TEXT_STATUSES = ["done", "empty"] as const;
export type DocTextStatus = (typeof DOC_TEXT_STATUSES)[number];

/** Result of an extraction run. */
export const DocExtractResultSchema = z.object({
  documentId: z.string().uuid(),
  status: z.enum(DOC_TEXT_STATUSES),
  charCount: z.number().int().nonnegative(),
});
export type DocExtractResult = z.infer<typeof DocExtractResultSchema>;

/** The stored extracted text + metadata for a document (null when not yet run). */
export const DocTextResponseSchema = z.object({
  documentId: z.string().uuid(),
  extracted: z.boolean(),
  status: z.enum(DOC_TEXT_STATUSES).nullable(),
  charCount: z.number().int().nonnegative(),
  extractedAt: z.string().datetime().nullable(),
  /** The extracted text (already capped at `DOC_EXTRACT_MAX_CHARS`), or null. */
  content: z.string().nullable(),
});
export type DocTextResponse = z.infer<typeof DocTextResponseSchema>;
