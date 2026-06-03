# ADR-0055: Knowledge Base / Wiki — spaces, ltree page tree, snapshot versions, threaded comments, TipTap editor

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P3.10 (a: spaces+pages+versions backend; b: threaded comments backend; c: web TipTap UI)
**Depends on:** RBAC (P1.1 / ADR-0019), tenant-context middleware + RLS (P0), audit (P1.11), ltree folder tree (P3.3 / ADR-0047), document versioning pattern (P3.4 / ADR-0049), web app shell + server-action pattern (P1.4+)

## Context

ToR §3.16 calls for a Knowledge Base / Wiki: a tenant's living documentation —
runbooks, procedures, references — organised hierarchically, rich-text, with
history and discussion. Four decisions were confirmed with the user before
locking the plan:

1. **Content format: TipTap/ProseMirror JSON** (not Markdown, not HTML). The
   editor is TipTap; storing its native JSON doc avoids lossy round-trips, and a
   server-derived plaintext column feeds full-text search.
2. **Structure: a nested page tree per space, via Postgres `ltree`** — reusing
   the exact pattern proven for folders (P3.3), not a parent-pointer-only model.
3. **History: snapshot-per-save versions** — reusing the document-versioning
   pattern (P3.4): an immutable row per save + a denormalised `current_version_no`.
4. **Access: tenant-wide `wiki:*` RBAC** for the MVP — per-space/per-page ACLs
   are deferred (the folder-grant machinery from P3.3b can be grafted on later).

## Decision

### Data model (P3.10a, migration 0028; P3.10b, migration 0029)

- **`wiki_spaces`** — top-level container (name, description, `created_by`,
  timestamps, soft-delete). Deleting a space soft-deletes its pages too.
- **`wiki_pages`** — one row per page: `space_id`, `parent_id` (self-FK,
  cascade), an **`ltree path`** (root→self; id-labels are the page UUID with
  hyphens stripped, same convention as folders), `title`, **`content` jsonb**
  (the ProseMirror doc, default `'{"type":"doc","content":[]}'`), **`content_text`**
  (server-derived plaintext), `current_version_no`, timestamps, soft-delete.
  A **GiST index** on `path` powers subtree queries (`path <@ ancestor.path`);
  a **GIN tsvector** index on `title || content_text` is ready for FTS.
- **`wiki_page_versions`** — immutable snapshot per save: `page_id`, `version_no`,
  `title`, `content`, `content_text`, `created_by`, unique `(page_id, version_no)`.
- **`wiki_comments`** (P3.10b) — `page_id` (cascade), **`parent_id` self-FK** for
  one threaded level, `author_id` (set-null so a deleted user doesn't orphan the
  thread), `body`, timestamps, soft-delete, `page` index.

Every table carries the **two-GUC RLS policy** (`app.bypass_rls` OR
`tenant_id = app.tenant_id`) + `FORCE ROW LEVEL SECURITY`, so the tenant boundary
is enforced in the database, not just the service.

### Service (`WikiService`)

- **Plaintext is derived server-side** — `extractText` walks the ProseMirror doc
  collecting `text` nodes; the client never supplies `content_text`, so search
  can't be poisoned and stays consistent with the stored doc.
- **Tree ops reuse the folder gotchas**: page creation computes `path` from the
  parent; **move** repaths the whole subtree with the
  `CASE WHEN path = self.path THEN newPrefix ELSE newPrefix || subpath(...) END`
  pattern + a same-space cycle guard; **delete** soft-deletes the subtree via
  `path <@ self.path`.
- **Versioning**: create writes v1; every `updatePage` appends `current+1` and
  repoints `current_version_no`; **restore = append a new version from the old
  snapshot + repoint** (history is append-only — restoring never rewrites).
- **Comments**: `createComment` validates a reply's parent is **on the same page**
  (else 400); `deleteComment` allows the **author OR a `wiki:manage` holder**
  (else 403) — `RbacService` is injected for that check.

### Permissions

`wiki:read` / `wiki:write` / `wiki:manage` (in `PERMISSION_CATALOG`). Controller
`@Authorize`: read for GETs, **write** for page edits + commenting, **manage**
for space create/delete. Seed: operator → read+write, auditor → read.

### Bodies are Zod-parsed in the controller

The ProseMirror `content` is an arbitrarily deep passthrough object —
class-validator can't model it. So routes take `@Body() body: unknown` and parse
with the contract schema (`ProseMirrorDocSchema = z.object({type}).passthrough()`),
turning failures into 400s. This matches the global `ValidationPipe`
(`whitelist` + `forbidNonWhitelisted`) which lets an untyped body through.

### Web UI (P3.10c)

- **TipTap** (`@tiptap/react` + `@tiptap/starter-kit` + `@tiptap/pm`, v2) — the
  editor JSON round-trips straight to the API. `useEditor` runs with
  **`immediatelyRender: false`** (required for Next SSR — avoids hydration
  mismatch); the editor is **remounted via a `key`** when the source content
  changes (switching pages / restoring a version) and `setEditable` toggles
  view↔edit without a remount.
- **`/wiki`** lists spaces (create gated on `wiki:manage`); **`/wiki/[spaceId]`**
  is a three-pane workspace — page **tree nav** (indented by `ltree` depth,
  inline create at root or as a child), **editor** (view/edit/save, version
  badge, delete), and a tabbed **History / Comments** panel (restore a version;
  threaded comments with reply, delete gated on author-or-manage using
  `userId` from `GET /rbac/me`).
- All mutations go through **`"use server"` actions** returning `ActionResult<T>`
  (the project's established BFF pattern); the sidebar "Knowledge Base" entry is
  enabled and `/wiki` added to the auth middleware's protected prefixes.

## Consequences

- **Good**: one tree pattern (ltree) and one versioning pattern (snapshot+pointer)
  now serve folders, documents, and the wiki — less novel code, fewer gotchas.
  Search-ready out of the gate (derived plaintext + GIN). The tenant boundary is
  DB-enforced. The editor stores structured content, so future features (mentions,
  embeds, backlinks) extend the schema, not replace it.
- **Trade-offs / deferred**: access is tenant-wide `wiki:*` (no per-page ACLs yet);
  comment threading is **one level** (replies don't nest further); no page
  templates, no real-time collaborative editing (Yjs — ToR §3.22), no move-in-UI
  (the backend supports move; the UI defers it). The wiki tsvector index exists
  but isn't yet wired into the federated `/v1/search` (P3.7) — a small follow-up.

## Validation

- **Backend e2e** (`wiki.e2e-spec` 7/7, `wiki-comments.e2e-spec` 4/4): space CRUD;
  nested tree + content round-trip + path order + derived plaintext; update→version
  bump + restore (append-only); move + cycle guard; delete subtree; threaded
  comments (oldest-first, cross-page-parent → 400, author/manager/non-author
  delete); `wiki:*` RBAC (manage vs write vs read); cross-tenant RLS → 404.
  Full suite **51 suites / 370 tests**, zero regressions. Migrations 0028 + 0029.
- **Web**: `tsc` + `next lint` + `next build` clean (TipTap bundles into the
  `/wiki/[spaceId]` route chunk). Live smoke: `/wiki` and `/wiki/[id]` 307→`/login`
  unauthenticated (middleware), `/login` 200, server log clean.
