# ADR-0048: Folder permission inheritance (restricted subtrees + grants)

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P3.3 (P3.3b)
**Depends on:** folder tree (P3.3a / ADR-0047), RBAC (P1.1), documents (P0.10)

## Context

P3.3a shipped the folder tree; access stayed tenant-wide RBAC (anyone with
`document:read`/`folder:read` saw everything). P3.3b adds **per-folder
permission inheritance** so subtrees can be made confidential. Three design
points were confirmed with the user: **restricted-subtree** composition,
**role + user** grant subjects, and **read/write** access levels.

## Decision

### Composition: restricted subtrees over tenant-wide RBAC

A folder carries a `restricted` flag. A folder is *effectively restricted* if it
**or any ancestor** is restricted (checked via the ltree path: `f.path <@ r.path`
for some restricted `r`). Effectively-restricted folders + their documents are
visible only to subjects with an inherited grant — plus `folder:manage` admins
and the folder's **creator**. Unrestricted folders keep today's RBAC behaviour,
so the feature is fully backward-compatible (opt-in confidentiality).

### Grants inherit down → the rule collapses to one ltree check

`folder_grants` rows are polymorphic (`subject_type` = `user` | `role`,
`subject_id`) with an `access` level (`read` | `write`); one row per
(folder, subject). A grant on a folder covers its whole subtree. The key
simplification: **access(F) ⇔ the user has a grant/creation on any
ancestor-or-self of F** (`F.path <@ grantPath`). No "nearest barrier vs nearest
grant" gymnastics — a grant anywhere above F unlocks F, whatever restrictions
sit in between.

`FolderAccessService` resolves a per-user context — `{ isAdmin, folderRead,
folderWrite, readPaths, writePaths, restrictedPaths }` — where `readPaths` =
grant(read|write) ∪ created-by and `writePaths` = grant(write) ∪ created-by.
Then:
- `canRead(p)` = admin ∨ (∃ readPath ⊒ p) ∨ (folderRead ∧ ¬effectivelyRestricted(p))
- `canWrite(p)` = admin ∨ (∃ writePath ⊒ p) ∨ (folderWrite ∧ ¬effectivelyRestricted(p))

### Decision cache

The context is cached in Redis (`cmc:folderacc:{tenant}:{user}`, 60 s TTL),
mirroring `PermissionCacheService`. It's invalidated **tenant-wide** on any
change that moves the inputs — restrict toggle, grant add/remove, and folder
create/move/delete (paths shift). Best-effort: Redis down → resolve from DB.

### Enforcement

- **Folders**: `tree` filters to readable nodes; `getOne` 404s an unreadable
  folder (hides existence); `create`-under-parent / `rename` / `move` / `delete`
  require write on the folder (and move also on the new parent).
- **Documents**: `list` adds a correlated ltree predicate (unfiled OR folder
  readable); `getOne` / `download-url` / `preview-url` 404 a document in an
  unreadable folder; filing (`upload-init`, `multipart/init`, `:id/move`)
  requires write on the target folder (400 if it's gone, 403 if no write).
- **Grant management** (`PATCH /folders/:id/restrict`, `POST|GET|DELETE
  /folders/:id/grants`) is gated on a new **`folder:manage`** permission
  (tenant_admin via `*`); restriction/grant changes are audited.

## Consequences

**Positive**
- Real confidential folders/documents, inherited down subtrees, on top of the
  existing tenant RBAC — no behaviour change for unrestricted content.
- The whole model reduces to ltree ancestor checks (cheap, GiST-friendly) + a
  cached per-user context. Role grants fan out for free.
- Verified end-to-end: restricted folder hidden from non-grantees; user + role
  grants unlock it; read ≠ write; documents filtered + blocked; admin + creator
  bypass.

**Negative / deferred**
- **No allow/deny ACL** — a grant only widens access into a restricted subtree;
  you can't deny a sub-folder to someone granted above it (would need the full
  allow/deny model that was explicitly not chosen).
- **Search not yet filtered** — the P2.11 `/v1/search` results aren't access-
  filtered for restricted folders yet (a follow-on; the documents *list* is).
- **Tenant-wide cache invalidation** — coarse (clears all users on any change);
  fine at current scale, could be per-subject later.
- **No grant audit UI / web surface**; no per-document override (folder-level
  only).

## Validation

- **Suite**: 310/310, 40 suites (+6). `folder-access`: restricted folder hidden
  from non-grantees + admin bypass; user grant unlocks; **role grant** unlocks
  all role members; read grant ≠ write (child create 403 → 201 after write
  grant); documents filtered from list + 404 on get for non-grantees, visible to
  grantee/admin; **creator** keeps access after restriction. Real Postgres + RLS
  + ltree + Redis cache.
- **Build/lint**: contracts + db + API `tsc`, `nest build`, `eslint` clean.
  Migration `0022` (`folders.restricted` + `folder_grants` + RLS).
