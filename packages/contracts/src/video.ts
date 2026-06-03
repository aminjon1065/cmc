import { z } from "zod";

/**
 * Video conferencing (P4.2 / ADR-0061). Rooms are our metadata over a LiveKit
 * SFU room; the browser joins with a short-lived, room-scoped LiveKit token
 * minted by the API (never the platform access JWT). Standalone today, with
 * `linkedType`/`linkedId` reserved for attaching a room to an incident/case.
 */

export const VIDEO_LINK_TYPES = ["incident", "case"] as const;
export type VideoLinkType = (typeof VIDEO_LINK_TYPES)[number];

export const VideoRoomSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** LiveKit SFU room name (the token's `room` grant). */
  livekitRoom: z.string(),
  status: z.enum(["open", "closed"]),
  linkedType: z.enum(VIDEO_LINK_TYPES).nullable(),
  linkedId: z.string().uuid().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});
export type VideoRoom = z.infer<typeof VideoRoomSchema>;

export const CreateVideoRoomSchema = z.object({
  name: z.string().min(1).max(200),
  /** Reserved link to a domain entity (both required together, or neither). */
  linkedType: z.enum(VIDEO_LINK_TYPES).optional(),
  linkedId: z.string().uuid().optional(),
});
export type CreateVideoRoomRequest = z.infer<typeof CreateVideoRoomSchema>;

export const VideoRoomResponseSchema = z.object({ room: VideoRoomSchema });
export type VideoRoomResponse = z.infer<typeof VideoRoomResponseSchema>;

export const VideoRoomsListResponseSchema = z.object({
  rooms: z.array(VideoRoomSchema),
});
export type VideoRoomsListResponse = z.infer<
  typeof VideoRoomsListResponseSchema
>;

// ---------- Recordings (P4.2c) ----------

export const VideoRecordingSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  status: z.enum(["active", "complete", "failed"]),
  startedBy: z.string().uuid().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
});
export type VideoRecording = z.infer<typeof VideoRecordingSchema>;

export const VideoRecordingResponseSchema = z.object({
  recording: VideoRecordingSchema,
});
export type VideoRecordingResponse = z.infer<
  typeof VideoRecordingResponseSchema
>;

export const VideoRecordingsListResponseSchema = z.object({
  recordings: z.array(VideoRecordingSchema),
});
export type VideoRecordingsListResponse = z.infer<
  typeof VideoRecordingsListResponseSchema
>;

/** GET /v1/video/recordings/:id/download — a presigned URL for the MP4. */
export const VideoRecordingDownloadResponseSchema = z.object({
  url: z.string(),
});
export type VideoRecordingDownloadResponse = z.infer<
  typeof VideoRecordingDownloadResponseSchema
>;

/** POST /v1/video/rooms/:id/token — a room-scoped join credential. */
export const VideoJoinResponseSchema = z.object({
  /** LiveKit access token (short-lived, room-scoped JWT). */
  token: z.string(),
  /** WS URL of the LiveKit server the browser connects to. */
  url: z.string(),
  /** LiveKit room name to join. */
  roomName: z.string(),
  /** This participant's stable identity (the user id). */
  identity: z.string(),
  /** Whether the SFU is actually enabled (else the client shows "unavailable"). */
  enabled: z.boolean(),
});
export type VideoJoinResponse = z.infer<typeof VideoJoinResponseSchema>;
