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
});
export type UploadInitRequest = z.infer<typeof UploadInitRequestSchema>;

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
