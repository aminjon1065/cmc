import { z } from "zod";

/**
 * Document folders (P3.3 / ADR-0047) — a per-tenant hierarchy stored as an
 * `ltree` materialised path (id-based labels, so renames never repath). The API
 * exposes `parentId` + `depth` for tree building; the raw path stays internal.
 * Per-folder permission inheritance (ACLs) is the P3.3b follow-on.
 */
export const FolderSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  name: z.string(),
  /** 1 for a root folder; depth in the tree (= ltree nlevel). */
  depth: z.number().int().positive(),
  /** This folder is restricted at its own level (P3.3b). */
  restricted: z.boolean(),
  /** Retention policy in days (inherited down); null = none (P3.5). */
  retentionDays: z.number().int().positive().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Folder = z.infer<typeof FolderSchema>;

// ---------- access grants (P3.3b / ADR-0048) ----------

export const FOLDER_ACCESS_LEVELS = ["read", "write"] as const;
export type FolderAccessLevel = (typeof FOLDER_ACCESS_LEVELS)[number];

export const FOLDER_GRANT_SUBJECT_TYPES = ["user", "role"] as const;
export type FolderGrantSubjectType =
  (typeof FOLDER_GRANT_SUBJECT_TYPES)[number];

export const FolderGrantSchema = z.object({
  id: z.string().uuid(),
  folderId: z.string().uuid(),
  subjectType: z.enum(FOLDER_GRANT_SUBJECT_TYPES),
  subjectId: z.string().uuid(),
  /** Display name of the subject (user/role), best-effort. */
  subjectName: z.string().nullable(),
  access: z.enum(FOLDER_ACCESS_LEVELS),
  createdAt: z.string().datetime(),
});
export type FolderGrant = z.infer<typeof FolderGrantSchema>;

export const SetFolderRestrictedSchema = z.object({
  restricted: z.boolean(),
});
export type SetFolderRestrictedRequest = z.infer<
  typeof SetFolderRestrictedSchema
>;

/** Set/clear a folder's retention policy (P3.5). null clears it. */
export const SetFolderRetentionSchema = z.object({
  retentionDays: z.number().int().positive().nullable(),
});
export type SetFolderRetentionRequest = z.infer<
  typeof SetFolderRetentionSchema
>;

export const CreateFolderGrantSchema = z.object({
  subjectType: z.enum(FOLDER_GRANT_SUBJECT_TYPES),
  subjectId: z.string().uuid(),
  access: z.enum(FOLDER_ACCESS_LEVELS),
});
export type CreateFolderGrantRequest = z.infer<typeof CreateFolderGrantSchema>;

export const FolderGrantResponseSchema = z.object({ grant: FolderGrantSchema });
export type FolderGrantResponse = z.infer<typeof FolderGrantResponseSchema>;

export const FolderGrantsListResponseSchema = z.object({
  grants: z.array(FolderGrantSchema),
});
export type FolderGrantsListResponse = z.infer<
  typeof FolderGrantsListResponseSchema
>;

export const CreateFolderSchema = z.object({
  name: z.string().min(1).max(255),
  /** Parent folder; omit / null for a root folder. */
  parentId: z.string().uuid().nullable().optional(),
});
export type CreateFolderRequest = z.infer<typeof CreateFolderSchema>;

export const RenameFolderSchema = z.object({
  name: z.string().min(1).max(255),
});
export type RenameFolderRequest = z.infer<typeof RenameFolderSchema>;

export const MoveFolderSchema = z.object({
  /** New parent; null moves the folder to the root. */
  parentId: z.string().uuid().nullable(),
});
export type MoveFolderRequest = z.infer<typeof MoveFolderSchema>;

export const FolderResponseSchema = z.object({ folder: FolderSchema });
export type FolderResponse = z.infer<typeof FolderResponseSchema>;

export const FoldersListResponseSchema = z.object({
  folders: z.array(FolderSchema),
});
export type FoldersListResponse = z.infer<typeof FoldersListResponseSchema>;
