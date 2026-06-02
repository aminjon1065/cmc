# ADR-0047: Document folder tree (ltree materialised path)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P3.3 (P3.3a)
**Depends on:** documents (P0.10), RBAC (P1.1), RLS

## Context

ToR §9.1 calls for a hierarchical folder model for files; §9.2 for permission
inheritance. P3.3 was split (confirmed with the user): **P3.3a** ships the folder
tree + document filing now; **P3.3b** adds per-folder permission inheritance
(ACLs + a decision cache + enforcement) — the design-heavy part, since today
document access is pure tenant-wide RBAC with no per-resource ACL.

## Decision

### Tree storage: ltree materialised path (confirmed with the user)

`folders.path` is a Postgres `ltree` from the root to the folder (inclusive),
GiST-indexed. Descendants are `path <@ folder.path`; ancestors `@>`. `parent_id`
is kept alongside for cheap immediate-children queries + FK cascade. The
extension is enabled in the migration (`CREATE EXTENSION IF NOT EXISTS ltree`).

**Labels are folder ids with hyphens stripped** (UUIDs aren't ltree-label-safe).
The decisive consequence: because labels are ids — not names — **a rename touches
only `name`; only a move repaths.** Tenant isolation via the standard two-GUC RLS
policy; soft-deleted via `deleted_at`.

### Operations

- **create**: id generated app-side (so the path is known before insert);
  `path = parent.path + '.' + label(id)` (or just the label at the root).
- **rename**: `name` only.
- **move**: validate the new parent, reject moving into self/descendant
  (`newParent.path <@ self.path` → 400), then repath the whole subtree in one
  statement and update `parent_id`.
- **delete**: soft-delete the subtree (`path <@ self.path`) and **unfile** any
  documents in it (`folder_id = NULL`) so files survive their folder.

### Document ↔ folder linking

`documents.folder_id` (nullable, `ON DELETE SET NULL`). `upload-init` /
`multipart/init` accept an optional `folderId` (validated against the tenant);
`GET /v1/documents?folderId=` filters; `POST /v1/documents/:id/move` re-files /
unfiles. The `Document` contract gains `folderId`.

### RBAC

New `folder:read|write|delete` permissions (catalog + seeded to operator/auditor;
tenant_admin via `*`). All folder routes are `@Authorize`-gated; RLS scopes data
to the tenant.

## Consequences

**Positive**
- A real per-tenant hierarchy with O(1)-ish subtree reads (GiST `<@`) and a
  single-statement subtree move. Renames are free of repaths (id-based labels).
- Documents file/unfile/move cleanly; deleting a folder never loses files.
- Foundation for P3.3b permission inheritance (folder ACLs keyed on the subtree).

**Negative / deferred**
- **No permission inheritance yet** (P3.3b) — folder access is the tenant-wide
  `folder:*` RBAC; documents stay readable by anyone with `document:read`.
- **No move/rename web UI** (backend only).
- **Soft-delete unfiles documents** rather than offering trash/restore of the
  folder's contents — a restore flow is a follow-on.
- No per-folder document **count**/rollups; no depth cap (a pathological deep
  tree is bounded only by ltree's label limits).

## Validation

- **Suite**: 304/304, 39 suites (+9). `folders`: create/depth, tree order,
  rename (no repath), **move + subtree repath** (descendant depth follows),
  cycle guard (→ 400), soft-delete subtree + unfile docs, upload-init filing +
  unknown-folder 400, `?folderId=` filter + document move/unfile, `folder:*`
  RBAC (role-less → 403). Real Postgres + RLS + ltree.
- **Build/lint**: contracts + db + API `tsc`, `nest build`, `eslint` clean.
  Migration `0021` (folders + `documents.folder_id` + ltree + GiST + RLS).

## Notes / gotcha

`subpath(path, nlevel(oldPath))` raises **"invalid positions"** for the moved
folder's own row (offset == nlevel → no suffix). The repath uses a `CASE` that
maps the self row straight to `newPrefix` and only `subpath`s the descendants.
Caught by the move e2e.
