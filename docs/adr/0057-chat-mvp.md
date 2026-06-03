# ADR-0057: Chat MVP — channels, messages, threads, reactions, mentions; realtime over the P2.3 event plane

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P3.12 (a: channels+messages+realtime; b: threads+reactions+mentions+web)
**Depends on:** realtime WS gateway + NATS fan-out (P2.3 / ADR-0035), transactional outbox + relay (P2.1 / ADR-0031), notifications (P1.6 / ADR-0024), RBAC (P1.1 / ADR-0019), tenant RLS (P0), web app shell + server actions (P1.4+)

## Context

ToR §3.11 needs team chat. Scope was confirmed with the user as an MVP (no E2EE,
no video): **channels + messages + realtime** first (P3.12a), then **threads +
reactions + mentions + web** (P3.12b). Three decisions framed it:

1. **Tenant-open channels** — any tenant user with `chat:read` sees every channel;
   `chat:write` posts; `chat:manage` creates/deletes + moderates. Per-channel
   membership / private channels are deferred (they don't fit the subject-RBAC
   realtime cleanly — see below).
2. **Realtime rides P2.3, not a new transport.** A mutation emits a `chat` event
   to the outbox; the relay ships it to NATS `tenant.<id>.chat.<eventType>.v1`;
   the fan-out delivers it to subscribers of `tenant.<id>.chat.>` who hold
   `chat:read`.
3. **ClickHouse projection deferred** — chat persists to Postgres only for the
   MVP (analytics aren't needed to make chat work).

## Decision

### Data model (migrations 0031 + 0032)

`chat_channels` (name, description, soft-delete) + `chat_messages` (`channel_id`,
**`parent_id`** self-FK for one-level threads, `author_id` set-null, `edited_at`,
soft-delete, feed index `(tenant, channel, created_at)`) + `chat_reactions`
(`message_id`, `user_id`, `emoji`, **unique(message,user,emoji)** → idempotent
add). All carry the two-GUC RLS policy + FORCE RLS.

### Service (`ChatService`)

- **Channels**: create (`chat:manage`) / list / get / delete (soft-delete +
  cascade messages).
- **Messages**: post (`chat:write`) / list (top-level feed, oldest→newest with a
  `before` cursor) / edit / delete — **author OR `chat:manage`** for edit/delete.
- **Threads**: a reply carries `parentId`; the parent must be a **top-level**
  message **in the same channel** (one level deep — replies can't be nested).
  The feed lists `parent_id IS NULL` only; each message carries a `replyCount`;
  `GET …/messages/:id/replies` returns the thread.
- **Reactions**: add (on-conflict-do-nothing) / remove (own); each message is
  enriched with `reactions: {emoji, count, mine}[]` via a grouped query +
  `bool_or(user = me)`.
- **Mentions**: `CreateChatMessage.mentions` is an explicit `userId[]` (no fragile
  text parsing). Recipients are validated against tenant users (RLS-scoped) and
  fanned out as `chat.mention` notifications (P1.6) — best-effort, never blocks
  the post.
- **Every mutation `OutboxService.publish`es a `chat` event in the same request
  tx** (atomic with the write) → relay → NATS → fan-out.

### Realtime wiring

One line in the realtime layer: `chat → chat:read` in
`SUBJECT_AGGREGATE_PERMISSION`. A client subscribes to `tenant.<id>.chat.>` with
`chat:read` and receives `channel_created/deleted`, `message_created/updated/
deleted`, `message_reacted/unreacted`. No new realtime code — chat is just
another aggregate on the proven P2.3 plane. **The WS frame's `payload` is the
full event envelope; the producer's chat fields live under `payload.payload`.**

### Web (`/chat`, P3.12b)

Sidebar "Chat" + middleware-protected. A three-pane workspace: channel list
(create when `chat:manage`), message stream + composer (Enter to send), per-message
emoji reactions (toggle chips with counts + `mine`), and a thread side-panel
(reply + reply-count). All via `"use server"` actions.

**Realtime in the browser = polling, by deliberate choice.** The chat realtime
*backend* (P3.12a) is built and live-smoked end to end (HTTP → outbox → NATS →
fan-out → WS). The *browser*, however, consumes via a 4 s poll of the BFF rather
than opening a WebSocket, because the WS gateway authenticates with the user's
**JWT** and the platform keeps tokens **server-side** (the BFF posture — never
expose the access token to client JS, an explicit security constraint). Wiring
the browser to the WS gateway requires a **short-lived single-use WS ticket**
endpoint (so the JWT never reaches the browser) — that is the documented
follow-up; until then polling preserves the posture with near-real-time UX.

## Consequences

- **Good**: chat reuses the entire event/realtime stack (outbox → relay → NATS →
  fan-out) — adding it was one aggregate + one perm-map entry. Atomic
  event-on-write (no dual-write). Tenant isolation is DB-enforced. Reactions are
  idempotent by constraint; threads are bounded to one level (simple, predictable).
- **Trade-offs / deferred**: tenant-open channels (no membership/private channels —
  which would need per-channel realtime filtering the subject scheme can't
  express); browser uses polling pending a WS-ticket endpoint; no presence /
  typing / read-receipts; mention **UI** (autocomplete) deferred (the API +
  notifications are done + tested); no ClickHouse projection; no message search /
  attachments / edit-history; "load older" paging exists in the API (`before`)
  but the web shows the latest page only.

## Validation

- **e2e** (`chat.e2e-spec` 8/8): channel CRUD (+non-manager 403); message
  post/list/`before`-pagination + **outbox emit**; edit/delete author-vs-manager-
  vs-403; **threads** (reply excluded from feed, `replyCount`, replies endpoint,
  no-nesting 400); **reactions** (idempotent add, per-emoji count + `mine`,
  remove); **mentions** (→ `chat.mention` notification row); RBAC (viewer 403) +
  cross-tenant 404. Full suite **53 suites / 386 tests**, zero regressions.
  Migrations 0031 + 0032.
- **Live smoke** (`chat.live-smoke`, real NATS→WS, `NATS_ENABLED` +
  `REALTIME_ENABLED` + `NODE_ENV=development`): HTTP post → outbox → relay flush
  → NATS → fan-out → a `chat:read` WS subscriber receives `chat.message_created`.
- **Web**: `tsc` + `next lint` + `next build` clean; `/chat` 307→`/login`
  unauthenticated, `/login` 200, server log clean.
