import { z } from "zod";

/**
 * Realtime plane (P2.3 / ADR-0035): the WebSocket protocol shared between the
 * gateway (apps/api) and the browser client (apps/web). One long-lived socket
 * per authenticated session; the client subscribes to event subjects and the
 * gateway pushes matching events as they happen.
 *
 * Transport: a standard WebSocket at `REALTIME_PATH`. The access token is
 * presented at connect time via the `cmc-bearer` subprotocol (preferred — it
 * never lands in a URL/log) or, as a fallback, an `?access_token=` query param.
 * Every frame is a JSON object discriminated by `type`.
 */

/** WebSocket path (served under the API's /v1 contract). */
export const REALTIME_PATH = "/v1/realtime";

/**
 * The WebSocket subprotocol that carries the bearer token at connect:
 * `new WebSocket(url, ["cmc-bearer", accessToken])`. The gateway reads the
 * token from the second offered protocol and echoes `cmc-bearer`.
 */
export const REALTIME_SUBPROTOCOL = "cmc-bearer";

// ---------- Client → server ----------

/** Subscribe to one or more event subjects (NATS-style patterns allowed). */
export const RealtimeSubscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  subjects: z.array(z.string().min(1)).min(1),
});

/** Drop one or more existing subscriptions. */
export const RealtimeUnsubscribeMessageSchema = z.object({
  type: z.literal("unsubscribe"),
  subjects: z.array(z.string().min(1)).min(1),
});

/** Application-level liveness probe; the gateway replies with `pong`. */
export const RealtimePingMessageSchema = z.object({
  type: z.literal("ping"),
});

export const RealtimeClientMessageSchema = z.discriminatedUnion("type", [
  RealtimeSubscribeMessageSchema,
  RealtimeUnsubscribeMessageSchema,
  RealtimePingMessageSchema,
]);
export type RealtimeClientMessage = z.infer<typeof RealtimeClientMessageSchema>;

// ---------- Server → client ----------

/** Sent once on a successful, authenticated connection. */
export const RealtimeWelcomeMessageSchema = z.object({
  type: z.literal("welcome"),
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  /** Subscriptions carried into this connection (always empty today). */
  subscriptions: z.array(z.string()),
});

/** Ack for a `subscribe`: which subjects were accepted vs rejected (scope). */
export const RealtimeSubscribedMessageSchema = z.object({
  type: z.literal("subscribed"),
  accepted: z.array(z.string()),
  rejected: z.array(z.string()),
});

/** Ack for an `unsubscribe`. */
export const RealtimeUnsubscribedMessageSchema = z.object({
  type: z.literal("unsubscribed"),
  subjects: z.array(z.string()),
});

/** A delivered event: the resolved subject + the event envelope payload. */
export const RealtimeEventMessageSchema = z.object({
  type: z.literal("event"),
  subject: z.string(),
  payload: z.record(z.unknown()),
});

/** Reply to a `ping`. */
export const RealtimePongMessageSchema = z.object({
  type: z.literal("pong"),
});

/** A protocol/authorisation error for the preceding frame (non-fatal). */
export const RealtimeErrorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export const RealtimeServerMessageSchema = z.discriminatedUnion("type", [
  RealtimeWelcomeMessageSchema,
  RealtimeSubscribedMessageSchema,
  RealtimeUnsubscribedMessageSchema,
  RealtimeEventMessageSchema,
  RealtimePongMessageSchema,
  RealtimeErrorMessageSchema,
]);
export type RealtimeServerMessage = z.infer<typeof RealtimeServerMessageSchema>;

// ---------- Ops / status (HTTP) ----------

/** GET /v1/realtime/status — gateway health for ops (tenant:manage). */
export const RealtimeStatusResponseSchema = z.object({
  /** Whether the gateway is accepting connections (REALTIME_ENABLED). */
  enabled: z.boolean(),
  /** Currently open authenticated connections. */
  connections: z.number().int(),
  /** Total active subscriptions across all connections. */
  subscriptions: z.number().int(),
});
export type RealtimeStatusResponse = z.infer<
  typeof RealtimeStatusResponseSchema
>;
