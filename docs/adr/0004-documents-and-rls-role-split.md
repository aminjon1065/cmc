# ADR-0004: Documents module + Postgres role split for true RLS

**Status:** Accepted
**Date:** 2026-05-08
**Amends:** ADR-0003

## Context

Two threads converged in this iteration:

1. **First domain module.** ADR-0001 picked Documents as the canonical
   first business module — it exercises the persistence stack, object
   storage, audit, RLS, and the web UI plumbing in one shot. Anything
   built later (cases, geo, workflows) reuses the same scaffold.
2. **An RLS hole discovered while testing.** ADR-0003 enabled RLS
   policies and `FORCE ROW LEVEL SECURITY` on `users` / `sessions` /
   `audit_log`. The policies exist in `pg_policies`, but a manual
   cross-tenant probe showed Tenant A could *see* and *delete* Tenant
   B's rows. The tenant filtering visible in earlier "RLS works"
   smoke-tests turned out to be application-layer `WHERE user_id = ...`
   filtering, not policy enforcement. The ToR's "isolation by
   construction" property was an illusion.

This ADR ships the Documents module and closes the RLS hole.

## Decision

### 1. Documents module

`documents` table — one row per uploaded artifact (per ToR §3.9, §9):

| column | purpose |
|---|---|
| `id` | uuid PK; embedded in the storage key |
| `tenant_id` | FK; RLS predicate |
| `name`, `description`, `mime_type`, `size_bytes` | display + filtering |
| `storage_bucket`, `storage_key` | byte address in MinIO/S3 |
| `etag` | captured during finalize for cross-checks |
| `status` | `uploading` → `ready` (or `failed`) |
| `uploaded_by` | actor; FK to users |
| `metadata` | jsonb for future structured fields |
| `created_at`, `updated_at`, `deleted_at` | lifecycle (soft-delete) |

**Upload flow:** the API never proxies bytes.
1. `POST /documents/upload-init` — create a row in `uploading` state,
   mint a pre-signed PUT URL targeting `tenants/{tid}/documents/{did}`.
2. Browser PUTs file directly to MinIO via the URL.
3. `POST /documents/:id/finalize` — API HEADs the object to verify it
   exists and that the size matches the declared one, captures the ETag,
   flips `status` to `ready`. Mismatch → `failed` + 400.

**Download flow:** `GET /documents/:id/download-url` returns a 5-minute
pre-signed GET URL with `response-content-disposition` set to the
original filename (sanitised against header injection).

**List / get / delete:** standard. Delete is soft (`deleted_at`); we
also best-effort delete the underlying object — orphaned objects are a
known follow-up for a janitor job.

### 2. Storage layer

`StorageModule` wraps the AWS SDK v3 S3 client with two underlying
clients:

- `S3_INTERNAL` — points at `S3_ENDPOINT` (private DNS); used by the
  API for HEAD / DELETE.
- `S3_PUBLIC` — points at `S3_PUBLIC_ENDPOINT` (the host the *browser*
  can reach); used to mint pre-signed URLs.

In dev both are `http://localhost:9000`. In a container or behind a
proxy they diverge.

### 3. Postgres role split — the actual RLS fix

Root cause: the `cmc` role created by the postgres container at first
boot is a **superuser with `BYPASSRLS`**. Owners of tables already
bypass RLS by default (which `FORCE ROW LEVEL SECURITY` is meant to
counter), but **superusers and `BYPASSRLS` roles bypass even FORCE**.
ADR-0003's policies were silently no-ops for the API's connection.

Fix: introduce a second role.

| Role | Used by | RLS subject? |
|---|---|---|
| `cmc` (POSTGRES_USER, owner, superuser) | migrations, seed | No — legitimately bypasses |
| `cmc_app` (NOSUPERUSER NOBYPASSRLS, GRANTed read/write on tables) | API runtime connection pool | **Yes** |

`infra/postgres/init/02-roles.sql` creates `cmc_app` and grants
read/write on existing + future tables (`ALTER DEFAULT PRIVILEGES`).
The script runs on first container boot; for an existing volume it's
applied manually one time.

`apps/api/.env` now has two URLs:
- `DATABASE_URL` — the runtime pool connection (`cmc_app`).
- `DATABASE_OWNER_URL` — used by `pnpm --filter @cmc/db migrate` and
  `pnpm --filter @cmc/api seed`. Drizzle Kit (`generate`, `studio`)
  also prefers it.

`runPrivileged()` still works under `cmc_app`: the policies bypass on
`current_setting('app.bypass_rls') = 'on'`, which is GUC-based, not
role-based. No code change needed in the application — only a
connection-string change.

### 4. Web UI

`/documents` page (server component) lists the tenant's documents via
`authedApiFetch`. Three small pieces alongside:
- `UploadForm` — client component using `XMLHttpRequest` for upload
  progress (fetch's body-progress isn't broadly available yet).
- `DocumentRowActions` — Download (opens pre-signed GET in a new tab,
  which the browser saves under the original filename via
  Content-Disposition) and Delete (with `confirm()` and refresh).
- Server actions (`actions.ts`) that wrap the API calls, read
  `session.accessToken` server-side, and `revalidatePath('/documents')`
  after mutations.

Edge middleware extends the protected matcher to `/documents`.

## Consequences

**Positive:**
- Cross-tenant probes (`GET /documents/{other-tenant-id}` → 404,
  `DELETE` likewise) now fail at the database, not the application.
  `WHERE tenant_id = …` in service code is now belt + suspenders
  rather than the only line of defense.
- A canonical "domain module" template now exists. New modules
  (workflows, cases, GIS layers) clone this shape: schema → RLS
  migration → service through `tenantDb.run` → controller → contracts
  → server actions → UI.
- Pre-signed PUT/GET URLs mean the API never holds large file bodies.
- `cmc_app` as the runtime role is also the right shape for prod —
  least privilege, no superuser keys in the application config.

**Negative / known gaps:**
- **Existing dev volumes need manual role creation.** Documented in
  the migration file; new clones get the role on first boot.
- **Orphaned MinIO objects.** If `delete()` on the bucket fails after
  the row is soft-deleted, the bytes linger. A nightly janitor that
  reconciles `status='deleted'` rows with the bucket is queued.
- **No size-bytes upper bound is RLS-enforced.** Limit comes from the
  application config (`DOCUMENTS_MAX_UPLOAD_BYTES`); a malicious actor
  with a valid pre-signed PUT URL could upload more bytes than they
  declared. The finalize step rejects this and marks the row `failed`,
  but the bucket already holds the bytes. A bucket-level lifecycle
  rule that auto-deletes `failed` document keys is queued.
- **No content-type sniffing.** The MIME type is whatever the uploader
  declares. The DocumentsService accepts any IANA-shaped value. Worth
  adding magic-byte verification + an allowlist per tenant.
- **No file versioning yet.** New uploads under the same name are
  separate rows. Versioning (`document_versions` child table) is the
  natural next iteration.
- **No previews / thumbnail pipeline.** Queued.
- **No full-text search.** Filtering on `name`/`description` uses
  `ILIKE`; we'll add a `tsvector` generated column + GIN index when
  search becomes a UX issue.

## Migration triggers

- A second concurrent upload bug → reach for object-level locks in S3
  multipart upload semantics.
- File counts cross ~10⁶ per tenant → revisit pagination + add
  cursor-based listing.
- Compliance scope adds e-discovery → fast-track legal hold +
  immutable retention controls.
