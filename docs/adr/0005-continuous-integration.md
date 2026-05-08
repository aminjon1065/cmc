# ADR-0005: Continuous integration on GitHub Actions

**Status:** Accepted
**Date:** 2026-05-08

## Context

After four ADRs of substrate work the codebase has reached the point
where regressions become more expensive than absent CI: there are
formatting conventions in `.prettierrc`, lint rules per workspace, four
TypeScript compilers, four Drizzle migrations, two Postgres roles, RLS
policies, and a custom Docker image. A drift in any one of those is
silent unless something runs them on every change.

Constraints inherited from earlier ADRs:

- **No paid CI services** (per ADR-0001 §11). Travis Pro / CircleCI Plus
  / Buildkite Cloud / similar are all out.
- **Solo developer.** CI must add value without becoming a maintenance
  burden — fast feedback, no flake, minimal yak-shaving.
- **Repo will live on GitHub.** Already implied by the `gh` tool the
  user has installed.

## Decision

### 1. Provider: GitHub Actions

GitHub Actions is the obvious pick: free for public repos, generous
free tier for private ones, native to GitHub, no extra account/billing
to manage. Self-hosted runners remain an option if minutes ever
become a constraint — we're nowhere near that.

### 2. Two jobs in one workflow

`.github/workflows/ci.yml` defines:

| Job          | Purpose                                                                                                           | Time budget               |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `verify`     | `format:check` + `lint` + `typecheck` + `build` for every workspace                                               | < 3 min cold, < 90 s warm |
| `migrations` | Build `infra/postgres/Dockerfile`, run a fresh container, apply migrations, sanity-check schema + roles, run seed | < 3 min                   |

Two jobs (not one) so they parallelise on free runners and so a failed
unit-test-style failure doesn't hide a migration bug or vice versa. Both
fail-fast — there's no `continue-on-error`.

### 3. What the migrations job actually verifies

Each push validates:

- The custom Postgres Dockerfile still builds.
- Init scripts (`01-extensions.sql`, `02-roles.sql`) execute cleanly on
  a fresh data volume.
- `cmc` and `cmc_app` roles end up with the right `rolsuper` /
  `rolbypassrls` flags. Catches regressions like "someone gave the
  runtime role BYPASSRLS again."
- Every Drizzle migration applies in order, including the hand-written
  RLS migrations.
- `pg_policies` is non-empty after migrations — the policies live where
  they're supposed to live.
- The seed script runs and produces the expected tenant + admin user.

This is integration-style — slower than pure unit tests would be, but
it catches the categories of bug we've actually shipped (the RLS hole
in ADR-0003 → ADR-0004 would have been caught by step 4 of this job).

### 4. Concurrency control

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

A new push to the same branch cancels the in-flight run. Important on
free minutes: a fast-iterating PR doesn't burn through the budget.

### 5. Caching

- `actions/setup-node` with `cache: pnpm` caches the pnpm store keyed
  on `pnpm-lock.yaml`. Cold install is ~50 s; warm is ~5 s.
- Turbo's local cache (in `node_modules/.cache/turbo/`) is **not** yet
  cached to the GitHub Actions cache. Cold builds take seconds today;
  caching is a queued optimization for when build time grows.
- The custom Postgres image build is **not** yet GHA-cached. The build
  is ~30 s — adding `docker/build-push-action` with `cache-from` /
  `cache-to: gha` would shave ~25 s but adds a dependency. Queued.

### 6. Format check baseline

`pnpm format:check` runs Prettier in `--check` mode. To get a clean
starting state:

- `.prettierrc` was added with explicit defaults (so future Prettier
  major versions don't silently re-flow files).
- `.prettierignore` excludes `dist/`, `.turbo/`, `pnpm-lock.yaml`,
  Drizzle's `migrations/meta/` snapshots, and `docs/ToR.md` (the spec
  is hand-managed prose; auto-formatting it would churn line breaks).
- `pnpm format` was run once and committed as the baseline.

### 7. Dependency updates: Dependabot, not Snyk/Renovate-Cloud

`.github/dependabot.yml` opens weekly PRs grouped by ecosystem (NestJS,
Next/React, Drizzle, AWS SDK, types, eslint, AWS-SDK, Docker base
images, GitHub Actions). Grouping prevents the "one PR per dep" flood
that pushes solo devs to ignore Dependabot entirely.

Self-hosted Renovate would offer richer rules but requires running a
worker; not worth it for a solo project. Dependabot is GitHub-native
and free, satisfying the "no paid CI dependencies" rule.

### 8. ESLint config: opted out of `consistent-type-imports`

A tempting auto-fix (`@typescript-eslint/consistent-type-imports`)
broke NestJS DI when first applied: the rule rewrites
`import { Service }` to `import { type Service }`, which TypeScript
elides at emit time, so `reflect-metadata`'s `design:paramtypes`
records `undefined` for those parameters and DI fails at boot.

The rule stays disabled in `apps/api/eslint.config.mjs` with a comment
explaining the trap. Future opt-in would require either a per-file
override (DI-heavy files vs pure-utility files) or migration to a
DI strategy that doesn't depend on metadata reflection.

## Consequences

**Positive:**

- Every push runs the same checks the developer would run locally,
  including the integration-flavored migrations + seed.
- The RLS-bypass-via-superuser bug from ADR-0003/0004 would now fail
  CI: the migrations job's role-flag assertion catches it.
- Dependabot keeps the dependency graph fresh without manual sweeping.
- Format / lint / typecheck failures are loud and immediate; nothing
  rots silently.

**Negative / known gaps:**

- **No automated tests yet.** `pnpm test` is wired into the pipeline
  but every workspace currently has zero tests. First addition will be
  contract tests on the public APIs.
- **No e2e / browser test coverage.** Playwright in CI is queued.
- **No Docker image publish step.** When the project moves to a server
  deploy, add a `release` workflow that builds and pushes images on
  tags.
- **No Turbo / docker layer cache** — small wins available, deferred.
- **Single-OS, single-Node-version matrix** — Ubuntu 22.04, Node 22.
  Multi-OS / multi-Node would be overkill for a server-side project.

## Triggers for re-evaluation

- First flake / minute-budget pressure → introduce caching layers.
- First test suite written → add a `test` job (parallel to `verify`).
- Project goes public / open-sourced → evaluate adding CodeQL (free
  for public repos) and a release workflow.
