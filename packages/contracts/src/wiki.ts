import { z } from "zod";

/**
 * Wiki contracts (P3.10 / ADR-0055). Spaces hold a nested tree of pages; page
 * content is the TipTap/ProseMirror JSON doc; every save snapshots a version.
 * Access is tenant-wide `wiki:*` RBAC (MVP).
 */

/** A TipTap/ProseMirror document — an object with a string `type` ("doc"). */
export const ProseMirrorDocSchema = z.object({ type: z.string() }).passthrough();
export type ProseMirrorDoc = z.infer<typeof ProseMirrorDocSchema>;

// ---------- spaces ----------

export const WikiSpaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WikiSpace = z.infer<typeof WikiSpaceSchema>;

export const CreateWikiSpaceSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});
export type CreateWikiSpaceRequest = z.infer<typeof CreateWikiSpaceSchema>;

export const UpdateWikiSpaceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});
export type UpdateWikiSpaceRequest = z.infer<typeof UpdateWikiSpaceSchema>;

export const WikiSpaceResponseSchema = z.object({ space: WikiSpaceSchema });
export type WikiSpaceResponse = z.infer<typeof WikiSpaceResponseSchema>;
export const WikiSpacesListResponseSchema = z.object({
  spaces: z.array(WikiSpaceSchema),
});
export type WikiSpacesListResponse = z.infer<
  typeof WikiSpacesListResponseSchema
>;

// ---------- pages ----------

/** A page node in the tree (no content) — for the nav/tree view. */
export const WikiPageSummarySchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  title: z.string(),
  depth: z.number().int(),
  currentVersionNo: z.number().int(),
  updatedAt: z.string().datetime(),
});
export type WikiPageSummary = z.infer<typeof WikiPageSummarySchema>;

/** A full page (with content) — for the editor/viewer. */
export const WikiPageSchema = WikiPageSummarySchema.extend({
  content: ProseMirrorDocSchema,
  createdBy: z.string().uuid().nullable(),
  updatedBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type WikiPage = z.infer<typeof WikiPageSchema>;

export const CreateWikiPageSchema = z.object({
  spaceId: z.string().uuid(),
  parentId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(300),
  content: ProseMirrorDocSchema.optional(),
});
export type CreateWikiPageRequest = z.infer<typeof CreateWikiPageSchema>;

export const UpdateWikiPageSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  content: ProseMirrorDocSchema.optional(),
});
export type UpdateWikiPageRequest = z.infer<typeof UpdateWikiPageSchema>;

export const MoveWikiPageSchema = z.object({
  parentId: z.string().uuid().nullable(),
});
export type MoveWikiPageRequest = z.infer<typeof MoveWikiPageSchema>;

export const WikiPageResponseSchema = z.object({ page: WikiPageSchema });
export type WikiPageResponse = z.infer<typeof WikiPageResponseSchema>;
export const WikiPagesListResponseSchema = z.object({
  pages: z.array(WikiPageSummarySchema),
});
export type WikiPagesListResponse = z.infer<typeof WikiPagesListResponseSchema>;

// ---------- versions ----------

export const WikiPageVersionSchema = z.object({
  versionNo: z.number().int(),
  title: z.string(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  isCurrent: z.boolean(),
});
export type WikiPageVersion = z.infer<typeof WikiPageVersionSchema>;

export const WikiPageVersionsListResponseSchema = z.object({
  versions: z.array(WikiPageVersionSchema),
});
export type WikiPageVersionsListResponse = z.infer<
  typeof WikiPageVersionsListResponseSchema
>;

// ---------- comments (P3.10b) ----------

export const WikiCommentSchema = z.object({
  id: z.string().uuid(),
  pageId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  authorId: z.string().uuid().nullable(),
  body: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WikiComment = z.infer<typeof WikiCommentSchema>;

export const CreateWikiCommentSchema = z.object({
  body: z.string().min(1).max(10_000),
  /** Parent comment id for a threaded reply; omit for a top-level comment. */
  parentId: z.string().uuid().nullable().optional(),
});
export type CreateWikiCommentRequest = z.infer<typeof CreateWikiCommentSchema>;

export const WikiCommentResponseSchema = z.object({ comment: WikiCommentSchema });
export type WikiCommentResponse = z.infer<typeof WikiCommentResponseSchema>;

export const WikiCommentsListResponseSchema = z.object({
  comments: z.array(WikiCommentSchema),
});
export type WikiCommentsListResponse = z.infer<
  typeof WikiCommentsListResponseSchema
>;
