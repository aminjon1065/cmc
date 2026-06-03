import { z } from "zod";

/**
 * Realtime collaboration (P4.1 / ADR-0060): the browser-facing contract for the
 * Hocuspocus (Yjs) editing plane. The collaborative WS is a *separate* server
 * from the P2.3 realtime gateway; the browser authenticates to it with a
 * short-lived, single-use **ticket** (NOT the access JWT — BFF posture), minted
 * by `POST /v1/collab/ticket` after the caller's `wiki:write` on the page is
 * verified. The ticket is presented to Hocuspocus as the connection token and
 * consumed (GETDEL) at the WS handshake.
 */

/** POST /v1/collab/ticket — request a connection ticket for a wiki page. */
export const CollabTicketRequestSchema = z.object({
  /** The wiki page to collaborate on (becomes Hocuspocus doc `wiki.<id>`). */
  pageId: z.string().uuid(),
});
export type CollabTicketRequest = z.infer<typeof CollabTicketRequestSchema>;

/** POST /v1/collab/ticket — the minted ticket + everything the client needs. */
export const CollabTicketResponseSchema = z.object({
  /** Single-use, short-lived connection token (opaque). */
  ticket: z.string(),
  /** Hocuspocus document name to open (`wiki.<pageId>`). */
  docName: z.string(),
  /** WS URL of the collaboration server (server-configured public URL). */
  wsUrl: z.string(),
  /** Yjs/TipTap fragment field the editor binds to. */
  field: z.string(),
  /**
   * Whether the collaboration server is actually enabled. When false the client
   * skips the WS attempt and falls back to the manual save-based editor — no
   * need to wait for a connection timeout.
   */
  enabled: z.boolean(),
  /** Identity for the presence cursor (label shown to other collaborators). */
  user: z.object({ id: z.string().uuid(), name: z.string() }),
});
export type CollabTicketResponse = z.infer<typeof CollabTicketResponseSchema>;
