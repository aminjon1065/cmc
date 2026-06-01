# ADR-0018: Tenant branding extracted to data

**Status:** Accepted
**Date:** 2026-05-25
**Implements:** PRIORITY_EXECUTION_PLAN P0.11 — **completes the P0 band**
**Closes tech-debt:** TD-021
**Depends on:** ADR-0003 (RLS / tenant isolation pattern)

## Context

The web frontend hardcoded the Tajikistan-CMC org identity — "Crisis
Management Center", "Civil Defense · TJ", "Republic of Tajikistan's
emergency operations", "National Data Center · Dushanbe", build label,
metadata — across `login/page.tsx`, `layout.tsx`, `sidebar.tsx`, and the
dashboard hero. TD-021 (S2) flagged it: the second tenant could not be
onboarded without editing components. P0.11 moves this org identity into
a `tenant_branding` table served by the API, so a new tenant is a row,
not a code change.

## Decision

### 1. `tenant_branding` — one row per tenant, RLS-isolated

A table keyed by `tenant_id` (BOTH PK and FK → `tenants`, `ON DELETE
cascade`), so a tenant has at most one branding row. Columns:
`locale_default`, `logo_url`, `copy` (jsonb text-block bag), `theme`
(jsonb, reserved for TD-023 token work — empty today), timestamps.
RLS uses the same two-GUC pattern as every tenant table (`app.tenant_id`
isolation + `app.bypass_rls` for privileged paths), `FORCE ROW LEVEL
SECURITY` so the owner is bound too.

`copy` as a jsonb bag (not typed columns) means new strings are added
without a migration — the keys are documented in the `BrandingCopy`
contract.

### 2. One context-aware endpoint: `GET /branding`

A single public endpoint, no guard, that resolves differently by context:

- **Authenticated** (TenantContext middleware has run) → the caller's own
  branding, read inside the request's tenant-scoped transaction (RLS
  guarantees it sees only its own row).
- **Anonymous** (login page, root metadata — pre-auth) → the
  `DEFAULT_TENANT_SLUG` tenant's branding, read via a privileged
  (RLS-bypass) transaction since no tenant context exists yet.

Pre-auth resolution is the load-bearing reason this isn't simply a
tenant-scoped read: the login page and document `<title>` render *before*
anyone logs in, so they need a way to get the default tenant's branding
without a token. The privileged default-tenant lookup is that path.

### 3. The generic default lives in code; TJ specifics live ONLY in seed

`@cmc/contracts` ships `DEFAULT_BRANDING` / `DEFAULT_BRANDING_COPY` — a
**vendor-neutral** fallback ("Operational Intelligence Platform", no
country, no TJ). It is used three ways: when no tenant row exists, when a
tenant has no branding row, and to fill missing keys on a
partially-populated row. So the frontend always receives a complete
object.

The **Tajikistan-CMC values live in exactly one place**:
`apps/api/src/scripts/seed-branding.ts` (`TJ_CMC_BRANDING`), which the
seed upserts into the default tenant's row. Nothing in application code
references it. This is the inversion TD-021 asked for: the platform code
is generic; the tenant identity is data.

### 4. Resolver fills gaps; never leaks across tenants

`BrandingService.toBranding` merges a row's `copy` over
`DEFAULT_BRANDING_COPY`, so a tenant that sets only `orgName` gets the
generic default for every other key — **not** another tenant's value and
**not** an empty string. The e2e suite asserts the no-leak invariants
directly: a second tenant gets its own copy with no "Tajikistan" /
"Crisis Management Center" anywhere; a tenant with no row falls back to
generic, not to the default tenant's TJ copy.

### 5. Web: server-side fetch with fallback, two entry points

`apps/web/src/lib/branding.ts` exposes `getPublicBranding()` (anonymous,
for login + root metadata) and `getBranding()` (authenticated, for the
signed-in shell), both `cache()`-wrapped (per-render dedupe) and both
falling back to `DEFAULT_BRANDING` if the API is unreachable — a branding
blip never takes a page down. The hardcoded strings in `login`,
`layout` (now `generateMetadata` + dynamic `lang`), `sidebar` (props
threaded via `AppShell`), and the dashboard hero (`statusLocation`) are
all replaced. The headline is split on `\n` to preserve the mural's
two-line layout for any tenant's copy.

Pages that fetch branding flip from static to `ƒ (Dynamic)` — correct and
intended, since branding is per-tenant/per-request.

### 6. Scope boundary: branding, NOT demo data

Only the **org identity** moved. The dashboard's hardcoded *demo data*
(region rows, incident counts, "Cabinet briefed at 03:15", the flood-watch
ribbon) is a **separate** debt — TD-022, addressed when the Incidents
module + dashboard rebind land (P1.5 / P2.6). Mixing them would have
coupled two unrelated changes. The dashboard hero's "National Operational
Status · Dushanbe" *is* branding (now `statusLocation`); the numbers next
to it are demo data and stayed.

### 7. `theme` is a placeholder, paired with TD-023

The `theme` jsonb column exists but is empty `{}` everywhere. Per-tenant
colour/token overrides depend on the design-system refactor (TD-023,
inline-styles → tokens) that hasn't happened. Shipping the column now
means no migration when that work lands; shipping it empty means no
half-built theming.

## Consequences

**Positive:**

- TD-021 retired. A second tenant is onboarded by inserting a
  `tenant_branding` row — zero code changes. Verified: the web src has
  **no** remaining hardcoded TJ strings (grep-clean).
- The generic/specific split is enforced structurally: the platform code
  is vendor-neutral, the TJ identity is seed-only data.
- Tenant isolation + no-leak proven by 6 e2e tests (incl. second-tenant
  isolation and missing-row fallback). Full suite 83/83.
- Live-validated end-to-end: seed → DB → `GET /branding` returns the
  complete TJ-CMC copy anonymously; web builds with the per-request
  fetches.
- Pre-auth pages get branding without a token via the privileged
  default-tenant path — the architecturally tricky bit, handled.

**Negative / known gaps:**

- **`theme` unused** — per-tenant theming awaits TD-023 (design tokens).
  Column shipped empty to avoid a later migration.
- **No admin UI to edit branding** — it's seed/SQL only today. A
  branding editor belongs in the Admin Panel (P1.4).
- **No logo upload** — `logo_url` is a plain string; an actual asset
  pipeline (upload → storage → URL) is future work. Null → built-in
  emblem today.
- **Dashboard demo data still hardcoded** — deliberately out of scope
  (TD-022 / P1.5 / P2.6).
- **`muralHeadline` two-line convention** — encoded as a `\n` in the copy
  string + split on the client. Slightly implicit; a structured
  `headlineLines: string[]` would be cleaner if more multi-line fields
  appear.
- **Branding is unauthenticated** — by necessity (pre-auth pages). It
  exposes only org-identity copy, nothing sensitive; acceptable, and the
  edge can cache it.

## Triggers for re-evaluation

- Admin Panel lands (P1.4) → add a branding editor (CRUD on the row) with
  step-up auth.
- Design tokens land (TD-023) → populate `theme` with per-tenant colour
  overrides; wire a tenant theme provider.
- A real second tenant onboards → confirm the generic default reads
  cleanly for a tenant that sets only some keys, and add a logo-asset
  pipeline if they need a custom emblem.
- More multi-line copy fields appear → consider `string[]` line arrays
  over `\n`-encoded strings.

## References

- [PRIORITY_EXECUTION_PLAN P0.11](../audit/PRIORITY_EXECUTION_PLAN.md)
- [TECH_DEBT_REGISTER TD-021](../audit/TECH_DEBT_REGISTER.md) (+ TD-022 demo data, TD-023 design tokens)
- [ADR-0003](./0003-sessions-refresh-rls.md) — the RLS pattern reused
- ToR §3.2 (multi-tenancy), §12.2 (design system / theming)
