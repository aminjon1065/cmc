# ADR-0028: OpenAPI document generation + gated Swagger UI

**Status:** Accepted
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P1.10 (a + b)
**Depends on:** ADR-0027 (`/v1` versioning), ADR-0019 (RBAC), ADR-0022 (admin panel / BFF gating)
**Relates to:** the `@cmc/contracts` Zod source of truth

## Context

ToR §11.1 requires every endpoint to be defined in OpenAPI. The platform had
none. The wrinkle is architectural: **request** bodies are validated by
class-validator DTOs, but **response** shapes live in `@cmc/contracts` as Zod
schemas (the BFF and the API share them) and are returned as Zod-*inferred* TS
types — which erase at runtime, so a decorator-only approach can't see them.

## Decision

Generate one OpenAPI 3.0 document at boot, assembled from three sources, and
serve it behind the platform's own RBAC.

### Schema sources

1. **Routes** — `@nestjs/swagger`'s `SwaggerModule.createDocument` introspects
   every controller.
2. **Request bodies / query params** — the `@nestjs/swagger` **CLI plugin**
   (`nest-cli.json`, `introspectComments`) reads the class-validator DTOs at
   `nest build` and emits their schemas (`LoginDto`, `CreateIncidentDto`, …).
   *Note:* the plugin is a TS-compiler transform — it runs in `nest build`, not
   under ts-jest, so e2e tests assert plugin-independent facts and the live
   smoke verifies the DTO schemas.
3. **Response bodies** — every exported `*Schema` in `@cmc/contracts` is
   converted to an OpenAPI component via `zod-to-json-schema`
   (`target: openApi3`) and `$ref`'d onto each operation's success response
   through a central `${method} ${path}` → schema-name map. The Zod contracts
   are the single source of truth, so the doc can't drift from what the BFF and
   API actually exchange.

Result: 82 component schemas (64 from contracts + 18 DTOs), request + response
bodies on the operations that carry them.

### All cross-cutting metadata is post-processed, not decorated

Tags, the global `bearer` security requirement, public-endpoint overrides
(login / refresh / mfa-verify / password forgot+reset / public branding read),
and the response `$ref`s are all applied in one place
(`build-openapi-document.ts`) — **zero Swagger decorators on the 11
controllers**. One reviewable file owns the doc shape; controllers stay clean.
Paths are re-prefixed with `/v1` and operational endpoints (`/health*`,
`/metrics`) dropped (they're not part of the client contract — ADR-0027).

### Why a global prefix doc + post-process, not `enableVersioning` / decorators

Decorating every endpoint with `@ApiResponse({ type })` would require **classes**
for the response types — duplicating the Zod contracts as DTO classes, which is
exactly the drift we avoid. Post-processing from the contracts keeps one source
of truth. (See ADR-0027 for why a global `/v1` prefix over URI versioning.)

### Why OpenAPI 3.0.0, not 3.1

`@nestjs/swagger` emits 3.0-shaped path/parameter objects. Stamping `3.1.0` on
3.0 constructs produces an *invalid* hybrid; `zod-to-json-schema`'s `openApi3`
target is likewise 3.0. A valid 3.0.0 document that always matches the real
routes is worth more than an invalid "3.1". The 3.1 bump is a tracked follow-on
(needs @nestjs/swagger 3.1 support or a converter). Auto-generation from routes
(no per-route hand-maintenance, no drift) was the priority.

### Serving + gating

- **`GET /v1/openapi.json`** — a guarded NestJS controller (`OpenApiController`)
  serves the document built in `main.ts` and stashed in `OpenApiService`. Gated
  by `JwtAuthGuard` + `@Authorize("tenant:manage")` — the doc describes the full
  admin surface, so it is **not** anonymous. `@ApiExcludeController` keeps the
  meta-route out of the doc. `OPENAPI_ENABLED=false` → no document built → 404.
- **Swagger UI** lives in the web admin panel at **`/admin/api-docs`** (gated
  like every `/admin` page on `tenant:manage` via `getMyAccess`). The page
  **server-fetches** the spec through the BFF (`authedApiFetch` attaches the
  bearer server-side), so the browser never handles a raw token to read the
  docs. The renderer (swagger-ui-dist) loads from a pinned CDN; only the
  open-source UI comes from the CDN, never the gated spec. "Try it out" targets
  the API origin via an injected `servers` entry; the user supplies a token via
  Swagger UI's Authorize dialog.

## Consequences

**Positive**
- ToR §11.1 satisfied: every `/v1` endpoint is in the document, with request
  and response schemas sourced from the live contracts.
- No decorator sprawl; the doc is reviewable in one file and can't drift from
  the Zod contracts.
- Gated consistently with the rest of the platform (RBAC on the API, BFF on the
  web) — the full API surface isn't leaked anonymously.
- Toggleable (`OPENAPI_ENABLED`) for environments that want it off.

**Negative / deferred**
- **OpenAPI 3.1** upgrade — follow-on (TD).
- **Self-hosted Swagger UI assets** — currently CDN; air-gapped deployments need
  the assets bundled (TD).
- The `${method} ${path}` → response map is hand-maintained; a renamed route
  silently loses its response `$ref` (the e2e asserts the marquee ones, and a
  missing ref is graceful, not an error).
- **Try-it-out auth** requires the user to paste a token (the platform keeps the
  access token server-side by design).
- Success-status detection follows the generator's default (`201` for POST) even
  where a handler sets `@HttpCode(200)` — cosmetic.

## Validation

- **Suite**: 175/175, 20 suites (openapi spec: 11 tests — gating 401/403/200,
  valid doc, `/v1` paths, operational exclusion, bearer scheme, contract
  components registered, response `$ref`s, global+public security, tags).
- **Live smoke** (dev DB): 82 component schemas; `GET /v1/incidents` → 200
  `$ref IncidentsListResponse`; `POST /v1/incidents` body `$ref CreateIncidentDto`;
  tags `["incidents"]`; global `security:[{bearer:[]}]`; `POST /v1/auth/login`
  `security:[]`; `OPENAPI_ENABLED=false` → 404.
- **Build/lint**: API `tsc` + `nest build` clean; web `next build` + `next lint`
  clean (`/admin/api-docs` route built).
