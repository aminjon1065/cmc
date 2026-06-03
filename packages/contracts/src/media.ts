import { z } from "zod";

/**
 * Media management (P4.5 / ADR-0063). A streamable derivative of an uploaded
 * document: request a transcode, then play the HLS via the BFF stream proxy
 * (`/v1/media/assets/:id/playlist.m3u8` + segment proxy). `media:read`/`write`-
 * gated, tenant-scoped via RLS.
 */

export const MediaAssetSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  kind: z.enum(["video", "audio"]),
  status: z.enum(["pending", "processing", "ready", "failed"]),
  durationSec: z.number().int().nullable(),
  /** Text watermark burned into the transcode, if any (P4.5c). */
  watermark: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const CreateMediaTranscodeSchema = z.object({
  documentId: z.string().uuid(),
  /** Optional text watermark to burn into the output (e.g. tenant / label). */
  watermark: z.string().max(100).optional(),
});
export type CreateMediaTranscodeRequest = z.infer<
  typeof CreateMediaTranscodeSchema
>;

export const MediaAssetResponseSchema = z.object({ asset: MediaAssetSchema });
export type MediaAssetResponse = z.infer<typeof MediaAssetResponseSchema>;

export const MediaAssetsListResponseSchema = z.object({
  assets: z.array(MediaAssetSchema),
});
export type MediaAssetsListResponse = z.infer<
  typeof MediaAssetsListResponseSchema
>;
