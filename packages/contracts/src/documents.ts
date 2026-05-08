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

// ---------- download URL ----------

export const DownloadUrlResponseSchema = z.object({
  method: z.literal("GET"),
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type DownloadUrlResponse = z.infer<typeof DownloadUrlResponseSchema>;
