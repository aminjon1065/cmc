# ADR-0060: Realtime collaboration (Yjs) — Hocuspocus seam, ticket auth, co-editing, anchored comments

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P4.1 (a — substrate; b — web co-editor; c — anchored comments + offline)
**Depends on:** wiki knowledge base (P3.10 / ADR-0055), RBAC (P1.1 / ADR-0019), realtime gateway pattern (P2.3 / ADR-0035), Redis (ADR-0008), BFF auth posture (NextAuth session, access JWT kept server-side)

## Context

The wiki (ADR-0055) stored a page as a single ProseMirror document edited by one
person at a time with optimistic "last write wins" saves. ToR §3.22 / §7.9 call
for **realtime collaboration**: multiple people editing the same document with
presence, comments pinned to text, and offline tolerance.

CRDT-based collaboration (Yjs) is the proven approach. The questions were: how to
run the sync server without polluting the test runtime or the existing request
path; how the browser authenticates to a *second* WebSocket server without
holding the access JWT (our BFF posture — see chat, ADR-0057, which polls for
exactly this reason); how to keep the rest of the system (search, versions, non-
collab readers) working off the live CRDT state; and where anchored comments live.

## Decision

### 1. A dedicated, gated Hocuspocus (Yjs) server — not the P2.3 gateway (P4.1a)

The P2.3 `ws` gateway is a one-way *broadcast* plane (NATS → sockets). Yjs needs
the bidirectional y-sync protocol, so we run a **separate** `@hocuspocus/server`
on its own port (`HOCUSPOCUS_PORT`, default 3002). It is a **gated lazy seam**:
`@hocuspocus/server` + `yjs` are dynamic-imported (never enter jest) and the
server starts **only** when `HOCUSPOCUS_ENABLED=true` (default false). There is
deliberately **no** `NODE_ENV==='test'` skip — the `enabled` gate already keeps
it out of the default suite, and dropping the extra skip lets the live smoke boot
the real server under a fast, light test-mode app.

`CollabService` (decoupled from the WS so it's unit/e2e-testable) owns:
- **auth** — verify the connection, confirm the wiki page is in the caller's
  tenant, require `wiki:write`;
- **load** — return the stored `Y.Doc`, or seed a fresh one from the page's
  current ProseMirror JSON (first collaborator) via `TiptapTransformer.toYdoc`;
- **store** (debounced) — persist the encoded `Y.Doc` to `collab_docs.state`
  (bytea, RLS) **and** snapshot it back to `wiki_pages.content` + derived
  plaintext, so search / version history / non-collab reads stay current.

### 2. Browser auth via single-use Redis tickets — never the access JWT (P4.1b)

The browser must not hold the access JWT (BFF posture). To open the WS it first
calls `POST /v1/collab/ticket` (session-authed through the Next BFF; `wiki:write`
enforced at the guard **and** re-checked per-page → 403/404). The service mints a
random, **single-use** ticket stored in Redis (`collab:ticket:<rand>`, TTL
`HOCUSPOCUS_TICKET_TTL_SECONDS`) bound to `{user, tenant, page, docName}`. At the
WS handshake `authorizeConnection` tries `consumeTicket` (Redis `GETDEL` → single
use) and falls back to JWT verification (tests / the headless live smoke). The
client fetches a **fresh** ticket per (re)connect via the provider `token`
function, so a dropped socket re-auths cleanly without long-lived credentials.

### 3. Web co-editing: auto-collab with manual fallback (P4.1b)

The wiki editor uses TipTap `Collaboration` (StarterKit history disabled — Yjs
owns undo) + `collaboration-cursor` (presence) + `@hocuspocus/provider` bound to
a `Y.Doc`. Entering edit mode **auto-connects**; while live there is no manual
"Save" (Hocuspocus persists) — only "Done", and a title rename is a title-only
PATCH that leaves the collaborative body untouched. If the feature is off, the
user lacks permission, or the WS is unreachable, the editor **falls back** to the
existing save-based `PageEditor`. The collab WS URL is server-configured
(`HOCUSPOCUS_PUBLIC_URL`); in production it is reverse-proxied same-origin by
Caddy.

### 4. Offline reconcile via IndexedDB (P4.1c)

An `y-indexeddb` persistence provider is attached alongside Hocuspocus. Edits
made offline persist locally and merge automatically on reconnect (Yjs CRDT). A
subtle "Offline — changes saved locally" pill shows while disconnected.

### 5. Anchored comments in Postgres, anchored by Yjs relative positions (P4.1c)

Anchored comments **extend `wiki_comments`** (not a parallel store, not the CRDT
blob) with two nullable columns: `anchor` — the encoded Yjs **relative positions**
`{from,to}` (base64, via `y-prosemirror`) which auto-rebase as the text is edited
— and `anchor_text`, the quoted snapshot for display/fallback. This reuses the
existing threaded-comment infra, RBAC, notifications and audit, and keeps comments
queryable and durable even when collaboration is off. The web resolves each
anchor against the live doc to render highlight decorations (recomputed every
transaction so they track edits); a floating "Comment" button on a text selection
creates one; clicking a highlight flashes the comment in the side panel. Anchoring
is top-level only (a reply's anchor is dropped).

## Consequences

- **Positive:** true multi-user editing with presence; comments that stay pinned
  through edits; offline tolerance; the access JWT never reaches the browser;
  search / versions / non-collab reads keep working via the debounced snapshot;
  the heavy WS server stays out of the default test runtime.
- **Negative / trade-offs:** a second WS server to operate (single-instance for
  now — see follow-ons); the live CRDT state lives in `collab_docs` between
  snapshots (the wiki row lags by the debounce window); anchored-comment
  realtime delivery to *other* collaborators is on refetch, not pushed yet.

## Validation

- e2e `collab` **8/8** (auth 5-case; load-seed; store persist + wiki snapshot +
  reload; ticket mint / consume / single-use / doc-binding / dual-path).
- e2e `wiki-comments` **5/5** (incl. anchored comment anchor + snapshot round-trip;
  anchors ignored on replies).
- **Headless live smoke**: two real `@hocuspocus/provider` Node clients (one via a
  BFF **ticket**, one via JWT) connect to `wiki.<pageId>`; an edit CRDT-syncs
  between them and is snapshotted back to the wiki page.
- Web `tsc` / `lint` / `build` green. Full suite **54 suites / 398 tests**, zero
  regressions.
- **Coverage boundary (honest):** the relative-position encode/decode + highlight
  decorations run only in the browser (ProseMirror + y-prosemirror binding); they
  are covered by the type-check/build and the backend anchor round-trip, not by a
  headless DOM test. A Playwright two-browser test is a follow-on.

## Files

- Backend: `apps/api/src/modules/collab/` (`collab.service.ts`, `collab.server.ts`,
  `collab.controller.ts`, `collab.module.ts`), `packages/db/src/schema/collab-docs.ts`,
  `wiki_comments.anchor/anchor_text` (migrations 0033, 0034), `packages/contracts/src/collab.ts`,
  config `HOCUSPOCUS_*`.
- Web: `apps/web/src/app/api/collab/ticket/route.ts`,
  `apps/web/src/app/wiki/[spaceId]/{collab-page-editor,comment-anchor,comment-highlight,page-editor,wiki-workspace}.tsx`,
  presence-cursor CSS in `globals.css`.

## Follow-ons

- Multi-instance Hocuspocus (Redis-backed `@hocuspocus/extension-redis`) for HA.
- Push anchored-comment changes to live collaborators (ride P2.3) instead of refetch.
- Collaboration for dashboards / workflow diagrams (same substrate).
- Playwright two-browser test for cursors + anchored-comment highlights.
