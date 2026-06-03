import { z } from "zod";

/**
 * Chat contracts (P3.12 / ADR-0057). Tenant-open channels (visibility via
 * `chat:*` RBAC, not per-channel membership in the MVP) + messages. Realtime
 * rides the P2.3 WebSocket gateway: posts emit `chat` events to the outbox →
 * NATS `tenant.<id>.chat.<eventType>.v1` → fan-out to `chat:read` subscribers.
 * Threads + reactions + mentions land in P3.12b.
 */

// ---------- channels ----------

export const ChatChannelSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChatChannel = z.infer<typeof ChatChannelSchema>;

export const CreateChatChannelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateChatChannelRequest = z.infer<typeof CreateChatChannelSchema>;

export const ChatChannelResponseSchema = z.object({
  channel: ChatChannelSchema,
});
export type ChatChannelResponse = z.infer<typeof ChatChannelResponseSchema>;

export const ChatChannelsListResponseSchema = z.object({
  channels: z.array(ChatChannelSchema),
});
export type ChatChannelsListResponse = z.infer<
  typeof ChatChannelsListResponseSchema
>;

// ---------- messages ----------

/** Aggregated reaction for a message (P3.12b): one row per distinct emoji. */
export const ChatReactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number().int().positive(),
  /** Whether the requesting user reacted with this emoji. */
  mine: z.boolean(),
});
export type ChatReactionSummary = z.infer<typeof ChatReactionSummarySchema>;

export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().uuid(),
  authorId: z.string().uuid().nullable(),
  /** Parent message id for a threaded reply; null for a top-level message. */
  parentId: z.string().uuid().nullable(),
  body: z.string(),
  edited: z.boolean(),
  /** Number of (non-deleted) replies — only meaningful for top-level messages. */
  replyCount: z.number().int().nonnegative(),
  reactions: z.array(ChatReactionSummarySchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const CreateChatMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  /** Reply within a thread — must be a top-level message in the same channel. */
  parentId: z.string().uuid().nullable().optional(),
  /** User ids to @mention — each tenant member gets a notification. */
  mentions: z.array(z.string().uuid()).max(50).optional(),
});
export type CreateChatMessageRequest = z.infer<typeof CreateChatMessageSchema>;

export const AddChatReactionSchema = z.object({
  emoji: z.string().trim().min(1).max(32),
});
export type AddChatReactionRequest = z.infer<typeof AddChatReactionSchema>;

export const UpdateChatMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});
export type UpdateChatMessageRequest = z.infer<typeof UpdateChatMessageSchema>;

export const ChatMessageResponseSchema = z.object({
  message: ChatMessageSchema,
});
export type ChatMessageResponse = z.infer<typeof ChatMessageResponseSchema>;

/** Messages are returned oldest→newest; pass `before` (ISO) to page older. */
export const ChatMessagesListResponseSchema = z.object({
  messages: z.array(ChatMessageSchema),
  /** ISO timestamp to pass as the next `before`, or null when no older page. */
  nextBefore: z.string().datetime().nullable(),
});
export type ChatMessagesListResponse = z.infer<
  typeof ChatMessagesListResponseSchema
>;
