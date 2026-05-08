# ADR-0006: Integration test suite

**Status:** Accepted
**Date:** 2026-05-08
**Amends:** ADR-0005

## Context

ADR-0005 set up CI but flagged its biggest gap explicitly: `pnpm test`
was a no-op. CI without tests is signal-free — it catches type errors
and lint regressions but not behaviour drift. The auth substrate
(ADR-0002 → ADR-0003) and the documents module (ADR-0004) shipped with
manual e2e validation; the moment we add a second domain module those
manual probes will not scale.

This ADR ships the first batch of automated tests.

## Decision

### 1. One test layer: integration / e2e

Pure unit tests for the services we have today would mostly assert
"argon2.verify was called" or "drizzle was queried with this clause" —
shallow guarantees that pin implementation details rather than
behaviour. Skipped.

Instead, every test boots the real `AppModule`, hits the real router via
supertest, talks to a real Postgres, and (for the upload lifecycle) hits
real MinIO via real pre-signed URLs. The thing under test is an HTTP
endpoint; the assertion is on response shape and DB state. When we
_do_ want unit tests later (e.g., for SessionsService.rotate's
state machine), they get added under `src/**/*.spec.ts` with their own
config — the e2e suite stays the canonical truth.

### 2. Test harness layout

```
apps/api/test/
├── jest-e2e.config.js   # entry point — set as `pnpm test` default
├── env.ts               # loads .env.test and .env (in that order)
├── global-setup.ts      # idempotent: creates cmc_test, applies all
│                        #   migrations, ensures cmc_app role + grants
├── helpers/
│   ├── test-app.ts      # buildTestApp() → fully-configured INestApplication
│   ├── test-db.ts       # ownerSql() + truncateAll(), bypassing RLS
│   ├── test-fixtures.ts # createTenant / createUser / createTenantWithAdmin
│   └── test-auth.ts     # loginAs / refresh / authed(token) helpers
└── e2e/
    ├── health.e2e-spec.ts
    ├── auth.e2e-spec.ts
    ├── rls.e2e-spec.ts
    └── documents.e2e-spec.ts
```

### 3. Database isolation: a separate `cmc_test` database

Tests run against `cmc_test`, **not** the dev `cmc` database. This is
an explicit decision:

- `truncate all tables` between test cases is correct — it must not
  blow away dev data.
- The same Postgres container serves both. Less infrastructure to
  juggle than a dedicated test container.
- `global-setup.ts` is idempotent — applying migrations twice is a
  no-op (Drizzle tracks `__drizzle_migrations`); creating the role
  twice is wrapped in a `DO IF NOT EXISTS`.

Tests run **serially** (`maxWorkers: 1`) because they share one DB.
Parallelism would force per-test schema isolation, which is not yet
worth the complexity.

### 4. Authentication via the real flow

Every test that exercises a protected endpoint goes through
`POST /auth/login` to mint a real access token. No mocks. This
catches DI mis-wirings, middleware regressions, and JWT-claim
mismatches that a "fake user injection" wouldn't.

### 5. RLS as test-asserted invariant

`rls.e2e-spec.ts` is the structural regression for the bug discovered
in ADR-0004. It directly asserts:

- `cmc_app.rolsuper = false` and `cmc_app.rolbypassrls = false` —
  catches "someone gave the runtime role superuser again."
- Every tenant-scoped table has `rowsecurity = true` AND
  `forcerowsecurity = true` — catches "someone shipped a new table
  but forgot the RLS migration."
- Cross-tenant `GET / DELETE` returns 404 and the underlying row is
  unchanged — the operational guarantee.

### 6. Bug found while writing the tests

The documents-finalize tests caught a real correctness bug:
`DocumentsService.markFailed` was running its UPDATE on the request's
transaction, which then rolled back when the controller threw 400 for
`object_missing`. The fix mirrors the family-burn fix from ADR-0003
(refresh replay): wrap the `markFailed` UPDATE in `runPrivileged()` so
it commits independently of the request rollback.

This is exactly the class of bug pure unit tests would have missed —
each piece works in isolation; only the request-level rollback
semantics are wrong.

### 7. AWS SDK + Jest workaround

The AWS SDK v3 retry middleware uses dynamic `import()`, which Jest's
default `vm` integration rejects with
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`. The `test` script in
`apps/api/package.json` sets `NODE_OPTIONS=--experimental-vm-modules`
to enable VM modules. Stable enough in Node 22 LTS for our purposes;
revisit when Jest's ESM story finishes baking.

### 8. CI: `migrations` collapsed into `integration`

The previous `migrations` job was 90% the setup that the test suite
needs anyway. Combined into one `integration` job that:

1. Builds the custom Postgres image and starts it.
2. Boots a MinIO container and creates the `cmc-files` bucket.
3. Applies migrations to the `cmc` database (covers seed's prerequisites).
4. Runs the seed script (the migrations job's unique check — that the
   bootstrap path still works).
5. Provisions `apps/api/.env.test` from the example.
6. Runs `pnpm --filter @cmc/api test`, which independently spins up
   `cmc_test` via `global-setup.ts` and exercises the e2e suite.

`verify` (lint/typecheck/build) stays a separate parallel job.

## Consequences

**Positive:**

- 32 tests, ~4–5 s wall time. The whole CI run is faster than reading
  the response body of a manual curl loop.
- Cross-tenant 404 and "no superuser/no bypassrls" are now structural
  invariants — a regression on either fails CI.
- The `markFailed` bug — and the same class of "writes that must
  outlive the response" — is now load-bearing on a test, not on
  developer memory.
- The fixtures + helpers are a template for tests of the next domain
  modules (cases, geo) — `createTenantWithAdmin(sql, …)` then
  `loginAs(app, user)` then HTTP through the real router.

**Negative / known gaps:**

- **No web tests yet.** The Auth.js refresh dance, the upload form's
  XHR progress, the dashboard server component — all unverified.
  Playwright is the natural addition; queued.
- **No load / soak tests.** The replay-detection path runs once per
  test; concurrent rotations under contention aren't exercised.
- **No coverage report.** `--collectCoverage` would slow tests by
  ~30%; deferred until coverage is a question we actually need to
  answer.
- **Serial execution.** As suite count grows, switching to
  schema-per-worker isolation becomes worthwhile. Today the bottleneck
  is the test count, not the parallelism.
- **No mutation testing or property-based tests.** Both queued for
  when the surface stabilises.

## Triggers for re-evaluation

- Test runtime crosses ~30 s → migrate to schema-per-worker parallelism.
- A Web-only regression slips through → bring forward Playwright.
- A bug ships despite green CI → audit which test case _should_ have
  caught it; backfill.
