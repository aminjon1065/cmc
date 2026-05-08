# ADR-0007: Web e2e tests with Playwright

**Status:** Accepted
**Date:** 2026-05-08
**Closes gaps from:** ADR-0006

## Context

ADR-0006 shipped 32 API integration tests but explicitly left web testing
on the table. The gap was costly almost immediately: writing the web
suite uncovered two production bugs in the API client that no API test
could see, because the bugs lived between the browser and the server —
exactly where API-only tests have nothing to say.

## Decision

### 1. Browser: Chromium-only via Playwright

Playwright is the obvious choice — first-party support for Next.js, runs
both Chromium-based and WebKit/Firefox engines, mature locator API,
solid CI story. Single browser (`chromium`) is enough for now;
WebKit/Firefox add minutes of CI time without testing different code
paths in our app. Adding more engines is a one-line config change when
it earns its keep.

### 2. Test orchestration: Playwright manages both servers

`apps/web/playwright.config.ts` declares a `webServer` array that spawns
the built API and web processes with a complete env block. Both
servers point at the same `cmc_test` database used by the Jest API
suite. `globalSetup.ts` is idempotent: re-creates the database, runs
all Drizzle migrations, ensures `cmc_app` exists with the right grants.

Specs use `truncateAll` + `createTenantWithUser` in `beforeEach` to
provision per-test fixtures. Mirrors the `apps/api/test/` pattern so
contributors don't have to learn two harnesses.

### 3. Eleven specs, three concerns

`auth.spec.ts` (7 tests):

- Anonymous redirects to `/login` from `/`, `/dashboard`, `/documents`.
- Login happy path: form submission → /dashboard → user data on screen.
- Wrong password: stays on /login, error message shown.
- Sign-out: cookie cleared, subsequent /dashboard nav redirects again.
- Authed user hitting /login is bounced to /dashboard.
- `?next=...` query param respected after login.

`documents.spec.ts` (4 tests):

- Dashboard links to /documents.
- /documents starts empty.
- Upload lifecycle: file → presigned PUT to MinIO → finalize → row
  appears.
- Delete: row vanishes after confirm and revalidation.

The download-via-popup verification got pulled — MinIO returns
`Content-Disposition: attachment`, which Chromium treats as a download
(no document loads in the popup tab) and the test flaked on
`waitForLoadState`. The download URL contract is already covered by the
API e2e suite; reinstate a browser test when we ship a true preview UI.

### 4. Bugs found while writing tests

**(a) Headers-spread silently drops the Authorization header.**

`apps/web/src/lib/api.ts` had:

```ts
fetch(url, {
  ...init,
  headers: { "Content-Type": "application/json", ...init.headers },
});
```

When `init.headers` is a `Headers` object (which `authedApiFetch`
created by calling `new Headers(...).set("Authorization", ...)`),
`{...new Headers(...)}` does **not** spread the entries — `Headers`
stores its data internally, so the spread yields an empty object and
**every header set on it is lost**.

Symptom: every web → API call from server components returned 401. The
dashboard always rendered "API call failed" silently because no test
ever asserted it. Manual smoke tests didn't catch it because the
visible-by-default content (tenant slug, user name) came from the
encrypted Auth.js cookie, not from `/auth/me`.

Fix: build the merged `Headers` via the constructor, which accepts any
`HeadersInit` shape (plain object, array of tuples, another Headers):

```ts
const headers = new Headers(init.headers ?? {});
if (!headers.has("Content-Type")) {
  headers.set("Content-Type", "application/json");
}
```

**(b) `apiFetch` choked on 204 No Content.**

`return res.json()` on a `DELETE` that responded `204 No Content` threw
`SyntaxError: Unexpected end of JSON input`. Caller saw an opaque
`Unknown error` rather than a successful delete.

Fix:

```ts
if (
  res.status === 204 ||
  res.status === 205 ||
  res.headers.get("content-length") === "0"
) {
  return undefined as T;
}
return res.json();
```

Both bugs were structural — present since the documents module shipped,
invisible until something exercised the browser → API path. Exactly the
class of bug a unit test for `apiFetch` would never have produced.

### 5. Playwright in CI

`.github/workflows/ci.yml`'s `integration` job now runs Playwright after
the Jest API e2e suite:

- `actions/cache` caches `~/.cache/ms-playwright` keyed on
  `apps/web/package.json` so the ~95 MB Chromium download happens at
  most once per dependency change.
- On cache hit, only `playwright install-deps` runs (system libs);
  binaries stay cached.
- The full env block is set at the step level so the same Playwright
  config works locally and in CI without forking.
- On failure, the Playwright HTML report is uploaded as a workflow
  artifact for forensic review (`actions/upload-artifact@v4`,
  7-day retention).

`verify` job remains parallel — Playwright doesn't run there.

### 6. Why the API was running in `production` mode

`webServer` in Playwright spawns `node dist/main.js`, a build artifact.
Setting `NODE_ENV=production` keeps Auth.js's cookie behaviour aligned
with what users see when the app actually deploys. We briefly switched
to `development` while debugging, but reverted — the bug we were
hunting wasn't environment-related, and production is the correct
target to validate against.

## Consequences

**Positive:**

- Web flows are now load-bearing on tests. The two `apiFetch` bugs
  would have shipped without these.
- Authentication via the **real** Auth.js login flow — not mocked
  cookies — catches Auth.js / NestJS contract drift.
- Document upload exercises browser → presigned-MinIO PUT → API
  finalize, the same path users hit. End-to-end including bytes on
  the wire.
- Fixtures are isomorphic with the Jest harness — test code reads the
  same on both sides.

**Negative / known gaps:**

- **Single browser engine.** WebKit/Firefox are skipped. CSS or
  cookie-handling regressions specific to non-Blink engines won't be
  caught.
- **Auth.js refresh dance is not exercised.** The 15-minute access
  token is too long to wait through in a test. A future iteration
  parameterises `JWT_ACCESS_TTL` per spec (e.g. 5 s) so refresh can
  be observed without mocking time.
- **No web component / unit tests.** Vitest + Testing Library is the
  natural addition once the component surface is large enough for
  unit-level assertions to pay back the maintenance.
- **Download lifecycle is partially covered.** Browser-side verification
  was dropped as flaky; the API e2e covers the contract.
- **No visual regression.** Screenshot diffs would be valuable once the
  design system stabilises.

## Triggers for re-evaluation

- A real visual bug ships → add Percy/Playwright screenshot diffs.
- Cross-browser bug appears → enable Firefox/WebKit projects.
- Auth-refresh regresses → invest in test-mode-shortened TTLs.
