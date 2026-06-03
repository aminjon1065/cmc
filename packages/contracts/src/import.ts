import { z } from "zod";

/**
 * Bulk data-import contracts (P3.11 / ADR-0056). A job references an
 * already-uploaded source object (`sourceKey`) + a `kind` selecting the parser
 * and target domain. The worker validates per-row, commits valid rows, and
 * quarantines the rest. Counts are polled via the job; bad rows via the errors
 * endpoint.
 */

/**
 * Parser + target selector. `*_incidents` kinds map tabular rows to incidents;
 * `*_gis` kinds map features to a GIS layer (and require a `targetId`).
 */
export const ImportKindSchema = z.enum([
  "csv_incidents",
  "xlsx_incidents",
  "geojson_gis",
  "shapefile_gis",
]);
export type ImportKind = z.infer<typeof ImportKindSchema>;

/** Whether a kind targets a GIS layer (and so requires `targetId`). */
export function importKindNeedsLayer(kind: ImportKind): boolean {
  return kind === "geojson_gis" || kind === "shapefile_gis";
}

export const ImportStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);
export type ImportStatus = z.infer<typeof ImportStatusSchema>;

export const CreateImportRequestSchema = z
  .object({
    kind: ImportKindSchema,
    /** Object key of the uploaded source file in the files bucket. */
    sourceKey: z.string().min(1).max(1024),
    /** Target row id — required for `geojson_gis` (the layer to fill). */
    targetId: z.string().uuid().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (importKindNeedsLayer(v.kind) && !v.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetId"],
        message: `targetId (GIS layer) is required for ${v.kind} imports`,
      });
    }
  });
export type CreateImportRequest = z.infer<typeof CreateImportRequestSchema>;

// ---------- source upload (P3.11b) ----------

export const ImportUploadInitRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().max(150).optional(),
});
export type ImportUploadInitRequest = z.infer<
  typeof ImportUploadInitRequestSchema
>;

/** A presigned PUT for the import source object + the key to import from. */
export const ImportUploadInitResponseSchema = z.object({
  sourceKey: z.string(),
  upload: z.object({
    url: z.string().url(),
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string().datetime(),
  }),
});
export type ImportUploadInitResponse = z.infer<
  typeof ImportUploadInitResponseSchema
>;

export const ImportJobSchema = z.object({
  id: z.string().uuid(),
  kind: ImportKindSchema,
  sourceKey: z.string(),
  targetId: z.string().uuid().nullable(),
  status: ImportStatusSchema,
  totalRows: z.number().int().nonnegative(),
  insertedRows: z.number().int().nonnegative(),
  failedRows: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type ImportJob = z.infer<typeof ImportJobSchema>;

export const ImportJobResponseSchema = z.object({ job: ImportJobSchema });
export type ImportJobResponse = z.infer<typeof ImportJobResponseSchema>;

export const ImportJobsListResponseSchema = z.object({
  jobs: z.array(ImportJobSchema),
});
export type ImportJobsListResponse = z.infer<
  typeof ImportJobsListResponseSchema
>;

export const ImportRowErrorSchema = z.object({
  rowNum: z.number().int().positive(),
  reason: z.string(),
  raw: z.unknown().nullable(),
});
export type ImportRowError = z.infer<typeof ImportRowErrorSchema>;

export const ImportRowErrorsListResponseSchema = z.object({
  errors: z.array(ImportRowErrorSchema),
});
export type ImportRowErrorsListResponse = z.infer<
  typeof ImportRowErrorsListResponseSchema
>;
