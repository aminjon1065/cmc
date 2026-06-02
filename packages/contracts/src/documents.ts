import { z } from "zod";

/**
 * Document metadata visible to the user. The byte-level details
 * (storage_key, etag) deliberately stay server-side.
 */
export const DocumentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  status: z.enum(["uploading", "ready", "failed"]),
  uploadedBy: z.string().uuid(),
  /** Preview kinds available for this document (e.g. ["image"]); P2.13. */
  previewKinds: z.array(z.string()),
  /** Folder this document is filed in; null = unfiled (P3.3). */
  folderId: z.string().uuid().nullable(),
  /** Live version number (P3.4). */
  currentVersionNo: z.number().int().positive(),
  /** Retention override in days; null = inherit the folder policy (P3.5). */
  retentionDays: z.number().int().positive().nullable(),
  /** Retention + deletion suspended while true (P3.5). */
  legalHold: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Document = z.infer<typeof DocumentSchema>;

// ---------- list ----------

export const ListDocumentsResponseSchema = z.object({
  documents: z.array(DocumentSchema),
  total: z.number().int().nonnegative(),
});
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponseSchema>;

// ---------- single ----------

export const DocumentResponseSchema = z.object({
  document: DocumentSchema,
});
export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;

// ---------- upload init ----------

export const UploadInitRequestSchema = z.object({
  name: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  description: z.string().max(2000).optional(),
  /** File the document into this folder on creation (P3.3). */
  folderId: z.string().uuid().nullable().optional(),
});
export type UploadInitRequest = z.infer<typeof UploadInitRequestSchema>;

// ---------- move (re-file) ----------

export const MoveDocumentRequestSchema = z.object({
  /** Target folder; null unfiles the document (P3.3). */
  folderId: z.string().uuid().nullable(),
});
export type MoveDocumentRequest = z.infer<typeof MoveDocumentRequestSchema>;

// ---------- versions (P3.4 / ADR-0049) ----------

export const DocumentVersionSchema = z.object({
  versionNo: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  etag: z.string().nullable(),
  /** SHA-256 hex, or null when over the hash size cap. */
  contentHash: z.string().nullable(),
  mimeType: z.string(),
  uploadedBy: z.string().uuid().nullable(),
  isCurrent: z.boolean(),
  createdAt: z.string().datetime(),
});
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

export const DocumentVersionsListResponseSchema = z.object({
  versions: z.array(DocumentVersionSchema),
});
export type DocumentVersionsListResponse = z.infer<
  typeof DocumentVersionsListResponseSchema
>;

/** Start a new version upload (returns a presigned PUT). */
export const InitVersionRequestSchema = z.object({
  sizeBytes: z.number().int().positive(),
  /** Override the MIME type for this version; defaults to the document's. */
  mimeType: z.string().min(1).max(255).optional(),
});
export type InitVersionRequest = z.infer<typeof InitVersionRequestSchema>;

export const InitVersionResponseSchema = z.object({
  document: DocumentSchema,
  versionNo: z.number().int().positive(),
  upload: z.object({
    method: z.literal("PUT"),
    url: z.string().url(),
    headers: z.record(z.string()),
    expiresAt: z.string().datetime(),
  }),
});
export type InitVersionResponse = z.infer<typeof InitVersionResponseSchema>;

// ---------- retention + legal hold (P3.5 / ADR-0050) ----------

export const SetDocumentRetentionSchema = z.object({
  /** Days after last update before soft-delete; null = inherit folder policy. */
  retentionDays: z.number().int().positive().nullable(),
});
export type SetDocumentRetentionRequest = z.infer<
  typeof SetDocumentRetentionSchema
>;

export const SetLegalHoldSchema = z.object({ hold: z.boolean() });
export type SetLegalHoldRequest = z.infer<typeof SetLegalHoldSchema>;

export const RetentionSweepResponseSchema = z.object({
  swept: z.number().int().nonnegative(),
});
export type RetentionSweepResponse = z.infer<
  typeof RetentionSweepResponseSchema
>;

// ---------- search reindex (P3.6) ----------

export const ReindexResponseSchema = z.object({
  /** Documents pushed into the search index (0 when the index is disabled). */
  indexed: z.number().int().nonnegative(),
});
export type ReindexResponse = z.infer<typeof ReindexResponseSchema>;

// ---------- document search (P3.6b) ----------

export const DocumentSearchResponseSchema = z.object({
  documents: z.array(DocumentSchema),
  /** Which engine served the results: OpenSearch when enabled, else Postgres. */
  backend: z.enum(["opensearch", "postgres"]),
});
export type DocumentSearchResponse = z.infer<
  typeof DocumentSearchResponseSchema
>;

export const UploadInitResponseSchema = z.object({
  document: DocumentSchema,
  upload: z.object({
    method: z.literal("PUT"),
    url: z.string().url(),
    headers: z.record(z.string()),
    expiresAt: z.string().datetime(),
  }),
});
export type UploadInitResponse = z.infer<typeof UploadInitResponseSchema>;

// ---------- finalize ----------

export const FinalizeUploadResponseSchema = z.object({
  document: DocumentSchema,
});
export type FinalizeUploadResponse = z.infer<
  typeof FinalizeUploadResponseSchema
>;

// ---------- multipart upload (P2.12 / ADR-0042) ----------

export const MultipartInitRequestSchema = z.object({
  name: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  description: z.string().max(2000).optional(),
});
export type MultipartInitRequest = z.infer<typeof MultipartInitRequestSchema>;

export const MultipartPartUrlSchema = z.object({
  partNumber: z.number().int().positive(),
  url: z.string().url(),
});
export type MultipartPartUrl = z.infer<typeof MultipartPartUrlSchema>;

export const MultipartInitResponseSchema = z.object({
  document: DocumentSchema,
  uploadId: z.string(),
  partSize: z.number().int().positive(),
  parts: z.array(MultipartPartUrlSchema),
  expiresAt: z.string().datetime(),
});
export type MultipartInitResponse = z.infer<
  typeof MultipartInitResponseSchema
>;

export const MultipartCompleteRequestSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        etag: z.string().min(1),
      }),
    )
    .min(1),
});
export type MultipartCompleteRequest = z.infer<
  typeof MultipartCompleteRequestSchema
>;

// ---------- download URL ----------

export const DownloadUrlResponseSchema = z.object({
  method: z.literal("GET"),
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type DownloadUrlResponse = z.infer<typeof DownloadUrlResponseSchema>;
