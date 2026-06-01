# ADR-0022: Admin Panel architecture (P1.4 series)

**Status:** Accepted (P1.4 complete — all four phases a–d shipped 2026-06-01)
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P1.4
**Depends on:** ADR-0019 (RBAC), ADR-0003 (sessions), ADR-0021 (admin password reset)
**Unblocks:** tenant self-service operations (user/role/tenant management without a developer)

## Context

ToR §3.19 calls for an administration UI. Today every operational task —
add a user, change a role, edit branding — is a developer task (SQL or a
seed edit). P1.4 builds `/admin/*` in the Next.js app, gated to tenant
admins, talking to the NestJS API.

P1.4 is an L-sized item, so it ships in **phases**, each a complete cycle
(code · tests · validation · docs):

- **P1.4a — Foundation** (this ADR's first increment): the "who am I /
  what may I do" endpoint, the gated `/admin` shell, the nav entry.
- **P1.4b — Users**: list / invite / deactivate / soft-delete / assign
  roles / trigger a password reset.
- **P1.4c — Roles**: the permission catalog + custom-role CRUD.
- **P1.4d — Tenant settings**: edit this tenant's name + branding.

Scope decisions taken up front: "Tenants" means a tenant_admin editing
**their own** tenant (cross-tenant superadmin CRUD is a separate platform
role for later); custom roles **are** in scope (P1.4c); step-up
re-authentication for destructive actions is **deferred** to a focused pass
(those actions are already permission-gated + audited).

## Decision

### 1. The API is the authorization boundary; the web gate is UX

Every admin endpoint is `@Authorize`-gated on a specific permission (e.g.
`user:manage`, `role:assign`). That server-side check is the real boundary —
it holds regardless of what the browser does. The web `/admin` layout's
redirect (below) is a **convenience**: it keeps a non-admin out of a section
they'd only see fail in, rather than being a security control. This means we
never have to trust the client, and the UI can be optimistic.

### 2. `GET /rbac/me` drives gating + navigation

Permissions are resolved **server-side per request** (ADR-0019), not carried
in the auth JWT — so the web app can't read a role off the token. P1.4a adds
`GET /rbac/me` → `{ userId, tenantId, roles[], permissions[] }`: the current
user's effective access. No `@Authorize` on it — every authenticated user may
read **their own** access (an operator who can't list roles can still learn
what they themselves hold).

The web wraps it in `getMyAccess()` (`lib/access.ts`), memoised per request
via React `cache()` so the `/admin` layout, the page, and the sidebar share a
single round-trip. It **fails closed**: a null result (no session, API down)
is treated as "no access". `isAdmin()` = holds `user:manage` (the
admin-section gate); individual pages additionally gate on their own
permission.

### 3. `/admin` layout redirect + middleware

`middleware.ts` adds `/admin` to the authenticated-only prefixes (an
unauthenticated visitor is bounced to `/login`, same as `/dashboard`). The
`/admin/layout.tsx` server component then calls `getMyAccess()` and
`redirect("/dashboard")` if the user isn't an admin — a second, role-aware
gate that middleware can't do (middleware has no permission data). The
sidebar's "Administration" entry is enabled only when `isAdmin()`.

### 4. Server components + server actions, reusing the documents pattern

Admin pages are React Server Components that read via `authedApiFetch`
(server-only, attaches the session bearer). Mutations are **server actions**
returning the established `ActionResult<T>` discriminated union
(`{ ok: true, data } | { ok: false, error }`) and calling `revalidatePath`
— exactly the documents-module pattern (ADR pre-existing). Forms validate
against the shared `@cmc/contracts` zod schemas, so the same schema guards
the request on the web and the response shape on return.

### 5. Custom, hand-rolled UI (no component-library dependency)

The app's design system is CSS-variable-based (`--c-*` tokens, `cmc-*`
classes), not a shadcn/Radix install. Admin tables/forms are built with the
same primitives so the panel matches the rest of the product and we don't
pull in a UI dependency mid-stream. (Re-evaluate if the surface grows enough
to justify a headless-component library.)

### 6. Step-up auth deferred

Destructive admin actions (deactivate, delete, role change) are permission-
gated and fully audited. A re-authentication challenge (re-enter password or
MFA before the action) is real defence-in-depth but orthogonal to the CRUD,
so it's a dedicated later pass rather than bloating P1.4. Noted as a known
gap, not an oversight.

## P1.4b — Users (delivered 2026-06-01)

The first CRUD slice, applying the model above.

- **Endpoints:** `GET /users`, `GET /users/:id`, `POST /users`,
  `PATCH /users/:id`, `DELETE /users/:id` — all `@Authorize("user:manage")`.
  RLS confines every read/write to the caller's tenant, so a cross-tenant id
  is a clean 404. Role assignment reuses the P1.1 `/rbac/users/:id/roles`
  endpoints; at creation the initial grants run inline in the same request
  transaction as the insert (`assignRole` uses the ambient `.run()` tx, so the
  just-inserted user row is visible to the grant and they commit together).
- **Passwordless invite:** `POST /users` creates an `is_active`, **password-
  less** user (login already rejects a null hash — verified). Since there's no
  email channel yet (P1.6), the admin then triggers an admin password-reset
  (P1.3) and relays the returned token. The UI shows a "No password" chip and a
  "Reset password" action that reveals the token to copy.
- **Deactivate / delete revoke sessions:** setting `is_active=false` or
  soft-deleting calls `SessionsService.revokeAllForUser` (+ cache del), so the
  user is evicted immediately, not at token expiry. A deactivated/ deleted
  account also can't re-login (`findActiveByEmailGlobal` filters
  `is_active`/`deleted_at`).
- **Self-action guards:** an admin cannot deactivate or delete **their own**
  account (403) — prevents an admin locking themselves out of the tenant.
- **`SessionsModule` extraction:** `SessionsService` moved out of AuthModule
  into its own module so UsersModule can revoke sessions **without** importing
  AuthModule (AuthModule imports UsersModule → that would be a cycle).
  AuthModule re-exports SessionsModule, so existing consumers
  (PasswordResetModule) are unchanged. Its deps are `@Global`, so the module
  needs no imports. Verified no DI cycle (auth + password-reset suites green).
- **Audit:** `user.created`, `user.updated`, `user.deactivated`, `user.deleted`
  — confirmed live.
- **Web:** `/admin/users` (server component: list + role-aware create form +
  table) with server actions returning `ActionResult<T>` and client row
  controls (activate/deactivate, reset-password-reveal, delete-with-confirm,
  add/remove role). The `/admin` overview's Users card is now live.
- **Validated:** 11 e2e (list/create/invite-login/409-dup/400-unknown-role/
  rename/deactivate-revokes/soft-delete/self-guards/operator-403/cross-tenant);
  full suite **126/126**; web build green + lint clean; live-smoke of the whole
  chain on the dev DB.

## P1.4c — Roles (delivered 2026-06-01)

Custom-role management over the P1.1 schema (which already had `is_system` +
per-tenant roles).

- **New permission `role:manage`** (create/edit/delete roles), distinct from
  `role:read` (view) and `role:assign` (grant to users). `tenant_admin` gets it
  via `*`; `operator`/`auditor` don't.
- **Endpoints:** `GET /rbac/permissions` (catalog, `role:read`),
  `GET /rbac/roles/:id` (`role:read`), `POST /rbac/roles`,
  `PATCH /rbac/roles/:id`, `DELETE /rbac/roles/:id` (all `role:manage`).
- **System roles are immutable:** edit/delete of an `is_system` role → 403.
  Custom roles are validated: slug `^[a-z][a-z0-9_]*$` + unique per tenant
  (409 on collision, including with a system slug), permission keys must be in
  the catalog (400 otherwise).
- **Cache invalidation:** a permission change (edit) or a delete can affect
  every user holding the role, so both call `PermissionCacheService.delTenant`
  — the whole tenant's cached permission sets are cleared; the DB stays
  authoritative. Verified live (assign → read OK → drop perm → read 403).
- **Delete cascades:** FK `ON DELETE CASCADE` on `user_roles`/`role_permissions`
  removes assignments automatically; `delTenant` then clears stale caches.
- **Catalog-change deploy note:** adding a permission to `PERMISSION_CATALOG`
  requires **re-running the seed** (`ensureSystemRolesForTenant` is idempotent
  and grants the new permission to `*` roles) AND letting the permission cache
  expire (or flushing `cmc:authz:*`). Observed live: a stale grant/cache made
  the admin 403 on the first try until re-seed + cache clear — which also
  confirms the seed correctly propagates new catalog permissions.
- **Audit:** `rbac.role.created`, `rbac.role.updated`, `rbac.role.deleted`.
- **Web:** `/admin/roles` — a create form + per-role cards. Custom roles edit
  inline (name/description + a domain-grouped permission picker) and delete;
  system roles render read-only. The `/admin` overview's Roles card is live.
- **Validated:** 7 new e2e (catalog / create+assign+effect / edit-revokes /
  delete-revokes / system-immutable / slug+perm validation / role:manage gate /
  cross-tenant 404); suite **133/133**; web build green + lint clean; live-smoke
  of the CRUD chain on the dev DB.

## P1.4d — Tenant settings (delivered 2026-06-01)

The final slice: a tenant_admin edits **their own** tenant.

- **New permission `tenant:manage`.**
- **Tenant identity:** `GET /tenant` + `PATCH /tenant { name }` (new
  `TenantsController`, class-gated `tenant:manage`). The id always comes from
  the auth context — there's no tenant id in the routes — so an admin can only
  ever edit their own tenant (the `tenants` table has no RLS; the application
  boundary is the control). Slug is immutable. Audited `tenant.updated`.
- **Branding:** `PUT /branding` added to the existing `BrandingController` at
  the **method level** (so `GET /branding` stays public/anonymous) gated by
  `tenant:manage`. Updates `localeDefault`, `logoUrl`, and `copy` — the copy
  bag is **merged** into the existing row (a partial submission preserves the
  rest), upserted into the single `tenant_branding` row, RLS-confined to the
  caller's tenant. `theme` is left untouched (reserved, TD-023). Audited
  `tenant.branding_updated`. Verified live: merge keeps `orgShort` while
  `orgName` changes.
- **Validation:** the nested `copy` bag is validated with the zod contract
  (`UpdateBrandingRequestSchema`) inside the controller rather than
  class-validator (which handles nested objects awkwardly); the un-typed
  `@Body()` lets the global pipe pass the raw body through to zod.
- **Web:** `/admin/tenant` — an Identity form (name + immutable slug) and a
  Branding form (locale, logo URL, the 12 copy fields). The `/admin` overview's
  Tenant card is live, completing the section.
- **Validated:** 7 e2e (get/rename/branding-update/copy-merge/validation/
  `tenant:manage` gate/public-GET); suite **140/140**; web build green + lint
  clean; live-smoke (rename + branding incl. merge) on the dev DB.

## P1.4 complete

All four phases shipped: **a** foundation · **b** Users · **c** Roles · **d**
Tenant settings. The Admin Panel covers user lifecycle, role/permission
management, and tenant identity/branding — every operation permission-gated at
the API, audited, and surfaced in a `tenant_admin`-gated `/admin` section.
Deferred by decision (tracked, not forgotten): cross-tenant platform-superadmin
administration, and step-up re-authentication for destructive actions.

## Consequences

**Positive:**

- A clean, fail-closed gating model: the API enforces, the web redirects for
  UX, and `GET /rbac/me` is the single source the nav + layout read.
- `getMyAccess()` is request-memoised, so gating adds at most one `/rbac/me`
  round-trip per page (and the API caches permissions in Redis).
- Phased delivery keeps each increment testable and reviewable; the
  foundation is provable on its own (4 new e2e tests; suite 115/115; web
  build green; `/rbac/me` live-validated showing `user:manage`).
- Server-action + zod-contract reuse means each subsequent admin page is a
  thin, consistent slice.

**Negative / known gaps:**

- **No step-up auth** — destructive actions rely on permission + audit only
  (deferred by decision).
- **Nav reflects permissions with cache latency** — a just-changed role shows
  in the nav only after the API's permission cache TTL (bounded, ADR-0019).
- **`/rbac/me` per page** — one extra call on every authed page (the sidebar
  reads it). Memoised + Redis-cached, so cheap, but non-zero.
- **Web has no MFA-login handling yet** — unrelated to admin, but the
  Credentials provider still can't complete an `mfa_required` login (P1.2
  deferred the web UI); an MFA-enabled admin can't sign in via the web until
  that lands.

## Triggers for re-evaluation

- Cross-tenant administration needed → introduce a platform-superadmin role +
  a separate `/platform/*` section (this ADR's gating model extends to it).
- The admin surface grows large → consider a headless component library for
  tables/dialogs/forms.
- Security review asks for step-up → add a re-auth challenge endpoint
  (verify password / MFA) + a short-lived "recently re-authed" marker the
  destructive server actions check.

## References

- [PRIORITY_EXECUTION_PLAN P1.4](../audit/PRIORITY_EXECUTION_PLAN.md)
- [ADR-0019](./0019-rbac.md) — permissions resolved server-side; `@Authorize`
- [ADR-0021](./0021-password-reset.md) — admin-reset surfaced in P1.4b
- ToR §3.19 (Administration / management UI)
