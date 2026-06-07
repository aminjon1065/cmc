# IMPLEMENTATION TRACKER
## Master matrix per ToR module

**Status:** snapshot as of 2026-05-24
**Source of truth:** [`docs/ToR.md`](../ToR.md) §3 + §4 + §16

**Status legend**
- `DONE` — module implemented, tested, can serve production load for the scoped capability (within Phase-1 constraints)
- `PARTIAL` — some endpoints / capabilities present, missing functional surface
- `STUB` — schema or skeleton exists, no usable behaviour
- `NOT STARTED` — neither code nor schema
- `BLOCKED` — depends on infrastructure not yet present
- `NEEDS REFACTOR` — exists but architecturally inadequate to grow

**Scoring (0–10)**

| Score axis | What it means |
|---|---|
| Compl. % | Functional completeness vs ToR section |
| Arch. | Compliance with ToR §2.3 architectural principles (event-first, tenant-first, idempotent, schema-explicit, observable, failure-isolated) |
| Prod. | Production-readiness (auth, error handling, audit, idempotency, edge cases) |
| Scale | Capability to reach the Horizon-1 user volume in ToR §1.6 (10³ users) without rewrite |
| Sec. | Security posture for what the module is supposed to do |

A `—` means "not applicable to a NOT STARTED module."

**Complexity (T-shirt):** XS (≤1 day), S (1 wk), M (2–3 wk), L (1 mo), XL (>1 mo), XXL (multi-month team effort)

---

## 3.1 Identity & Access Management

| field | value |
|---|---|
| **Status** | PARTIAL |
| **Compl. %** | 40 % |
| **Arch.** | 8/10 |
| **Prod.** | 8/10 |
| **Scale** | 7/10 |
| **Sec.** | 7/10 |
| **Code** | `apps/api/src/modules/auth/*`, `apps/api/src/modules/users/*`, `apps/api/src/common/rate-limit/*`, `apps/api/src/common/session-cache/*`, `apps/web/src/auth.ts`, `apps/web/src/middleware.ts` |

**Implemented**
- `POST /auth/login` with argon2id verify + timing-safe dummy verify
- `POST /auth/refresh` with single-use refresh + family-burn on replay
- `POST /auth/logout`
- `GET /auth/me`
- `GET /auth/sessions`, `DELETE /auth/sessions/:id`
- Session table backing every access JWT (`sid` claim → DB lookup at middleware)
- Web Auth.js v5 with credentials provider, transparent refresh dance, in-flight refresh dedup, signout-revokes-server-session event
- Edge middleware enforcing protected routes + `?next=` round-tripping
- Audit on every login outcome (durable for failures)
- **Rate limit on login/refresh** (P0.1 / ADR-0009) — Redis fixed-window with per-IP + per-email (SHA-256-hashed) counters; breach → 429 + Retry-After + durable denial audit. Trust-proxy posture limited to private networks so X-Forwarded-For can't be spoofed by external clients.
- **Session-active cache** (P0.4 / ADR-0011) — Redis-backed cache for the per-request session lookup. TTL matches access-token lifetime so failed cache DEL adds zero exposure. Invalidated on every revoke / rotate / replay-burn / expire path. Payload-mismatch falls through to DB (defence-in-depth). Cuts the hot-path DB SELECT load orders of magnitude.

**Gaps vs ToR §3.1**
- No OIDC server (no `.well-known/openid-configuration`, no JWKS endpoint, no third-party RP relationships)
- No SAML 2.0 / SSO / SCIM
- No service-account / API-key issuance
- ~~No MFA~~ ✅ TOTP MFA landed (P1.2 / ADR-0020): encrypted secret at rest, one-time backup codes, two-step `mfa_required` login, enrol/confirm/disable. WebAuthn + per-tenant enforcement still pending.
- ~~No password reset flow~~ ✅ password reset landed (P1.3 / ADR-0021): `password_resets` (single-use sha256-hashed token, RLS), self-service (no-enumeration) + admin-initiated (`user:manage`-gated) flows, race-safe CAS completion that revokes all sessions but leaves MFA intact, pluggable notifier (dev logger now → SMTP at P1.6). Email delivery still pending (P1.6).
- No tenant picker for cross-tenant email collision (TD-038; also makes ambiguous-email self-reset a no-op)
- ~~No rate limiting~~ ✅ closed by P0.1 (auth endpoints); global rate-limit still pending → P0.9
- No JIT provisioning from SSO claims
- RS256 + JWKS + key rotation (today HS256 — fine until services split, called out in ADR-0002)
- No revocation list propagated via NATS to other gateways (no other gateways exist)
- No bloom-filter revocation cache in Redis

**Blockers / deps**
- Redis cache for session-active lookup (perf, not correctness)
- NATS for revocation broadcast (only matters when a second service exists)

**Complexity to complete to ToR §3.1**
- ~~MFA + rate limit + password reset: **M**~~ ✅ all landed (P0.1 rate-limit, P1.2 MFA, P1.3 password reset)
- OIDC server (Keycloak adoption or self-built with `oidc-provider`): **L**
- SAML / SCIM: **L**
- RS256 + JWKS rotation: **S**

---

## 3.2 Multi-Tenancy

| field | value |
|---|---|
| **Status** | DONE (for shared-schema RLS model) |
| **Compl. %** | 50 % (one of the three tenancy options) |
| **Arch.** | 9/10 |
| **Prod.** | 8/10 |
| **Scale** | 6/10 |
| **Sec.** | 9/10 |
| **Code** | RLS migrations + `TenantContextMiddleware` + `TenantTransactionInterceptor` + `TenantDatabaseService` + `cmc_app` Postgres role |

**Implemented**
- Shared-schema RLS via `app.tenant_id` GUC
- `cmc_app` runtime role (`NOSUPERUSER NOBYPASSRLS`) + `FORCE ROW LEVEL SECURITY` on every tenant-scoped table
- `runPrivileged` escape hatch with try/finally GUC reset
- Cross-tenant access regression-tested at the API layer (`rls.e2e-spec.ts`)
- **Per-tenant branding extracted to data** (P0.11 / ADR-0018): `tenant_branding` table (RLS-isolated) + context-aware `GET /branding` (authed→own, anon→default tenant); generic `DEFAULT_BRANDING` in contracts, TJ-CMC values seed-only; web fetches branding server-side (no hardcoded org identity left). 6 isolation/no-leak e2e tests.

**Gaps vs ToR §3.2**
- No separate-schema-per-tenant option for high-isolation modules
- No dedicated-DB-per-tenant deployment mode
- No per-tenant DEK / envelope encryption via KMS/Vault Transit
- No tenant migration tooling (grow a tenant onto dedicated infrastructure)
- No tenant-scoped Redis namespacing pattern (Redis not yet wired)
- No per-tenant OpenSearch indices (OpenSearch not present)
- No tenant sharding strategy

**Complexity to complete:** **L** (cryptographic tenancy + migration tooling)

---

## 3.3 RBAC/ABAC Authorization

| field | value |
|---|---|
| **Status** | PARTIAL (RBAC ✅; ABAC pending) |
| **Compl. %** | 45 % |
| **Arch.** | 8/10 |
| **Prod.** | 8/10 |
| **Scale** | 7/10 |
| **Sec.** | 8/10 |
| **Code** | `packages/db/src/schema/rbac.ts`, `apps/api/src/modules/rbac/*`, `apps/api/src/common/authz/*`, `apps/api/src/common/permission-cache/*`, `packages/contracts/src/rbac.ts` |

**Implemented (P1.1 / ADR-0019)**
- Per-tenant `roles` + global `permissions` catalog + `role_permissions` + `user_roles`, all RLS-isolated (migration `0006`).
- `PERMISSION_CATALOG` + `SYSTEM_ROLES` in `@cmc/contracts` — single source of truth for seed + guard strings.
- `@Authorize('domain:action')` decorator + `AuthorizeGuard` (ALL-required; 403 + durable `rbac.access.denied` audit). Handles the guards-before-interceptors trap via `runForTenant` in the resolve path.
- `PermissionCacheService` (Redis, fail-open, TTL 300s, invalidated on assign/remove). `RbacService` (resolve/hasPermission/listRoles/listUserRoles/assign/remove/enforce).
- `RbacController`: roles list, user-roles list, assign/remove (gated `role:read`/`role:assign`).
- System roles (`tenant_admin`/`operator`/`analyst`/`auditor`/`hq`) seeded per tenant; documents `@Authorize`-protected per route. 9 e2e tests; live-validated. **`analyst`** (2026-06-04) = read-only ops + analytics + AI (`llm:use`), no writes/audit. Dev seed also creates demo accounts `analyst@`/`operator@`/`auditor@cmc.local` (pwd = admin seed pwd).

**Gaps vs ToR §3.3 / §6.2**
- No ABAC / OPA / Rego (PDP/PEP/PIP, attribute policies) — RBAC only.
- ~~No custom (non-system) role CRUD or permission editing API yet~~ ✅ custom-role CRUD landed (P1.4c / ADR-0022): `role:manage` perm, `GET /rbac/permissions` + `POST/PATCH/DELETE /rbac/roles`, system roles immutable, perm-cache invalidation on change, `/admin/roles` editor.
- No permission inheritance / hierarchy; no decision-cache metrics; system-role immutability is a flag, not a DB trigger.

**Complexity to complete to §3.3:** **XL** for OPA-driven ABAC end-to-end (RBAC done).

**Sequencing note:** ✅ satisfied — RBAC now precedes the domain modules (P1.5 Incidents onward ship `@Authorize` from day one).

---

## 3.4 GIS & Geospatial Intelligence (deep dive §4)

| field | value |
|---|---|
| **Status** | IN PROGRESS — substrate + tiles + map UI (P2.7–P2.9) |
| **Compl. %** | 28 % (schema/CRUD/bbox/RLS/RBAC + MVT tiles + MapLibre map) |
| **Arch.** | 7/10 |
| **Prod.** | 7/10 |
| **Scale** | 6/10 |
| **Sec.** | 8/10 |
| **Code** | `apps/api/src/modules/gis/{gis.service,gis.controller,gis.module,dto/*}.ts`, `packages/db/src/schema/{gis-layers,gis-features}.ts`, `0018` migration, `packages/contracts/src/gis.ts`; `apps/web/src/app/map/page.tsx`, `apps/web/src/components/cmc/map-view.tsx`, `apps/web/src/app/api/gis/tiles/[layerId]/[z]/[x]/[y]/route.ts` |

**Implemented**
- PostGIS in the dev image; extension ensured idempotently in migration 0018
- **`gis_layers`** + **`gis_features`** (`geometry(Geometry, 4326)`, GIST, soft-delete); **RLS** (two-GUC) on both
- `/v1/gis` API (P2.7b): layer + feature CRUD (`gis_layer:*`/`gis_feature:write`); GeoJSON I/O (`ST_GeomFromGeoJSON`/`ST_AsGeoJSON`, Zod-validated → 400); **bbox list** (`&& ST_MakeEnvelope`, GIST); audited; `featureCount`
- **MVT tile server (P2.8 / ADR-0038):** `GET /v1/gis/tiles/:layer/:z/:x/:y.mvt` — `ST_AsMVT` over GIST-filtered tenant features, 204 empty, Cache-Control; live-validated (86-byte tile)
- **MapLibre map (P2.9 / ADR-0039):** `/map` page + `MapView` (layer toggle + feature inspector); **BFF tile proxy** (`/api/gis/tiles/*`) keeps the API token server-side. **Theme-aware raster basemap (2026-06-05):** previously the basemap was an empty `minimalStyle` (a flat color slab → the map looked blank); now **CARTO light/dark raster tiles by default** (track the app theme, swap live on toggle without disturbing GIS layers), overridable to a self-hosted vector style (`NEXT_PUBLIC_MAP_STYLE_URL`) or any raster XYZ such as OSM (`NEXT_PUBLIC_MAP_RASTER_URL`) for offline/air-gapped use; compact OSM/CARTO attribution shown. Validated: `tsc`/`lint`/`next build` ✓, CARTO tile reachability (200 image/png), authed `/map` → 200 with `MapView` mounted (in-browser WebGL render = human check)
- **GeoServer — OGC interop (ADR-0079, Phase 1 · 2026-06-06):** OGC server (WMS/WFS/WMTS) over PostGIS so **QGIS + ArcGIS Pro + the web** share one GIS source. Compose service `geoserver` (`docker.osgeo.org/geoserver:2.26.1`, on `cmc-net`, persistent `geoserver_data` volume, healthcheck, admin pw via env). Connects with a **least-privilege read-only `geoserver_ro`** role (SELECT-only on gis_*, `BYPASSRLS` for single-site; never the superuser). Reproducible: role in `postgres/init/02-roles.sql`, workspace+datastore+layer via idempotent `infra/geoserver/setup.sh`. **Verified live:** WFS GetFeature → real GeoJSON (`Dushanbe HQ`), WMS GetMap → 200 png, WMS/WFS GetCapabilities → 200. Connection steps in `infra/geoserver/README.md`.
- **GeoServer — Phase 2 (per-layer SQL views + SLD · 2026-06-06):** `setup.sh` now publishes **one named layer per `gis_layers` row** (a `JDBC_VIRTUAL_TABLE` SQL view filtered by `layer_id`, slug name) — e.g. `cmc:flood_zones`, `cmc:tiles_smoke` — so QGIS/ArcGIS browse each thematic layer by its real title instead of one blob, and each WFS/WMS request returns only that layer's features. Added a clean **`cmc_default` SLD** (`infra/geoserver/styles/cmc_default.sld` — point=circle / line / filled-polygon in accent `#2f6fe0`), uploaded + set as the **default style** on every published layer (replaces GeoServer's "strange"-looking generic default). **Verified live:** WFS GetFeature on `cmc:tiles_smoke` → `numberMatched=1` (per-layer filter works), WMS GetMap with `cmc:cmc_default` → 200 image/png (2.4 KB, styled point rendered), default style = `cmc:cmc_default`, both named layers advertised in WMS + WFS GetCapabilities with titles. **Remaining phases:** Caddy front + auth + `PROXY_BASE_URL`; QGIS/ArcGIS runbook; load real data vs smoke layers; (editing/WFS-T deferred — route writes through the API for RBAC+audit)
- **GeoServer — Phase 3 (web consumes GeoServer WMS · 2026-06-06):** the web `/map` now renders the **same server-rendered, SLD-styled layers** as QGIS/ArcGIS. New **same-origin BFF proxy** `apps/web/src/app/api/gis/wms/route.ts` (NextAuth-gated; SSRF-safe — fixed GeoServer host+path, allow-listed WMS params, `request` ∈ {GetMap, GetFeatureInfo, GetCapabilities, GetLegendGraphic}) — the browser never hits GeoServer directly. `MapView` adds each GIS layer as a **WMS raster** source (MapLibre `{bbox-epsg-3857}` → `/api/gis/wms` GetMap) and clicks issue **GetFeatureInfo** through the proxy → the existing feature inspector (recovers the layer from the `<slug>.<fid>` feature id). Source switch `NEXT_PUBLIC_GIS_SOURCE` (`geoserver` default | `mvt` fallback); basemap stays independent so a GeoServer outage degrades to "basemap only", never blank. **Validated:** `tsc`/`lint`/`next build` clean; live browser (`/map`, 1440×900) → canvas 1220×796, **48 GetMap requests via `/api/gis/wms`**, in-page BFF probes GetMap → 200 png (2438 B) + GetFeatureInfo → 200 json returning the feature. Files: `apps/web/src/app/api/gis/wms/route.ts`, `apps/web/src/components/cmc/map-view.tsx`, `apps/web/.env(.example)`
- **Basemap picker (ADR-0039 addendum · 2026-06-06):** `/map` now has a **basemap selector** (was a single theme-aware CARTO basemap) — Авто (theme light/dark), Voyager, Светлая, Тёмная, OpenStreetMap, Спутник (Esri World Imagery), Топографическая (Esri Topo). Choice **persisted in `localStorage`** + applied live by swapping only the raster source (GIS layers stay on top). **All** basemap tiles go through the existing same-origin proxy `app/api/map/tiles/[variant]` — extended from CARTO-only to a fixed **SSRF-safe registry** (CARTO incl. Voyager's `rastertiles/voyager`; OSM; Esri imagery/topo with `{z}/{y}/{x}`; `User-Agent` for OSM policy). i18n: 8 new `map.basemap`/`map.bm.*` keys ×2 locales (parity 778/778). **Validated:** `tsc`/`lint`/`next build` clean (`/map` 6.13 kB); proxy probes light/dark/voyager→200 png, satellite/topo→200 jpeg, osm→200 png, bad key→400; live browser → 7 localized options, Спутник persisted + 24 satellite tiles fetched + Esri imagery of Tajikistan rendered. Files: `apps/web/src/components/cmc/map-view.tsx`, `apps/web/src/app/api/map/tiles/[variant]/[z]/[x]/[y]/route.ts`, `apps/web/messages/{ru,tg}.json`

**Gaps vs ToR §4**
- Geofencing, live-tracking pipeline, spatial analytics/clustering/heatmap, multi-CRS handling, tile caching/CDN; richer spatial ops (distance/within), import/export (GeoPackage/Shp); on-map editing; properties-schema enforcement; GIS domain events / realtime layer updates; an offline/self-hosted **bundled** basemap (online CARTO + custom-raster/style hooks now shipped; a fully offline tile server in compose is still pending)

**Complexity:** **XXL** (GIS is a whole product surface; ToR §19.4 calls for 3–5 dedicated GIS engineers) — substrate + tiles + map shell done; analytics/editing/live-tracking remain.

---

## 3.5 Analytics & Reporting

| field | value |
|---|---|
| **Status** | NOT STARTED |
| **Compl. %** | 0 % |
| **Arch.** | — |
| **Prod.** | — |
| **Scale** | — |
| **Sec.** | — |

**Implemented** — none.

**Gaps** — entirety of §3.5: no ClickHouse, no projector workers, no pre-built dashboards, no ad-hoc query DSL, no scheduled reports, no time-series/cohort/funnel analytics.

**Dashboard UI exists** (`/dashboard`) but renders **hardcoded demo data** with one real `/auth/me` panel. It's a UX scaffold, not an analytics surface.

**Complexity:** **XL** (ClickHouse cluster + projectors + dashboard builder + materialised views).

---

## 3.6 Realtime Event System

| field | value |
|---|---|
| **Status** | NOT STARTED |
| **Compl. %** | 0 % |

**Implemented** — none.
**Gaps** — no NATS/Kafka, no event bus, no outbox table, no AsyncAPI schemas, no idempotent consumer pattern, no `trace_id` / `causation_id` / `correlation_id` propagation.

**Implication:** every other module that the ToR describes as "emits an event" or "subscribes to an event" is blocked on this. Audit log is closest analogue but is not consumable as an event stream.

**Complexity:** **L** for the event-bus + outbox + first 2–3 consumers; **XL** to operationalise (DLQ, replay, monitoring, schema registry).

---

## 3.7 Dashboard Builder

| field | value |
|---|---|
| **Status** | NOT STARTED |

The static `/dashboard` page is a fixed-layout demo, not a builder. ToR §3.7 requires drag-and-drop widget grid, datasource binding, parameter/filter/drill-through. **Complexity: L.**

---

## 3.8 File Management System

| field | value |
|---|---|
| **Status** | PARTIAL |
| **Compl. %** | 20 % |
| **Arch.** | 8/10 |
| **Prod.** | 8/10 |
| **Scale** | 6/10 |
| **Sec.** | 7/10 |
| **Code** | `apps/api/src/modules/storage/*`, `apps/api/src/modules/documents/*` (overlaps with §3.9) |

**Implemented**
- Pre-signed PUT for direct browser upload
- Finalize HEADs the object, captures ETag, cross-checks size
- Pre-signed GET with `Content-Disposition` for download
- Soft-delete with best-effort object delete

**Gaps vs ToR §9 (Enterprise File Management)**
- ~~No hierarchical folder model~~ ✅ **Folder tree (P3.3a / ADR-0047):** `folders` (ltree materialised path of id-labels, GiST, RLS, soft-delete) + `/v1/folders` CRUD + subtree move (repath) + cycle guard; documents file/unfile/move via `documents.folder_id`; `folder:*` RBAC
- ~~Permission inheritance~~ ✅ **Restricted subtrees + grants (P3.3b / ADR-0048):** `folders.restricted` + `folder_grants` (user/role, read/write) inherit down the ltree subtree; `FolderAccessService` + Redis decision cache (`cmc:folderacc:*`); enforced on folders (tree/get/write) + documents (list/get/download/filing); `folder:manage` admin + creator bypass. Deferred: allow/deny ACL, `/v1/search` access-filtering
- ~~No versioning~~ ✅ **Document versioning (P3.4 / ADR-0049):** `document_versions` (immutable per-version + SHA-256 `content_hash`) + `documents.current_version_no` (denormalised current bytes); v1 at finalize + backfill; new-version upload, list, download any version, restore/rollback. Deferred: byte-dedup + refcount GC, diff/UI
- ~~No previews / thumbnail pipeline~~ 🟡 **Image previews (P2.13 / ADR-0043):** gated BullMQ worker + `sharp` — finalize/complete enqueues → worker renders WebP → `documents.metadata.previews` → `GET /v1/documents/:id/preview-url` (signed) + `previewKinds` on the contract. Remaining: PDF/video/audio (poppler/ffmpeg), backfill janitor, web UI
- No EXIF / PDF metadata extraction
- No external sharing links
- ~~No retention policies / legal hold~~ ✅ **Retention + legal hold (P3.5 / ADR-0050):** folder `retention_days` (inherited down ltree) + per-doc override + `legal_hold`; gated daily `RetentionService` sweep (soft-delete expired, skip holds) + manual `/documents/retention/sweep`; legal hold blocks deletion. Deferred: hard-purge, folder-level hold
- No object-level encryption per tenant (DEK/KEK)
- No tus.io resumable upload (today is single PUT)
- ~~No multipart upload~~ ✅ **S3 multipart (P2.12 / ADR-0042):** `/v1/documents/multipart/{init, :id/complete, :id/abort}` — presigned part URLs, resumable, real-MinIO tested. Remaining: `ListParts`-based resume, abandoned-upload GC, range reads
- No content-type sniffing / magic-byte verification
- No virus scanning
- No CDN / edge cache
- No content extraction → OpenSearch indexing
- No `failed`-status object lifecycle rule

**Complexity to complete to ToR §9:** **XL**

---

## 3.9 Enterprise Document Management (ECM)

| field | value |
|---|---|
| **Status** | PARTIAL (file-level only, no structured ECM yet) |
| **Compl. %** | 10 % |
| **Code** | `apps/api/src/modules/documents/*` |

**Implemented** — file-level upload/download/list/delete as a flat namespace per tenant.

**Gaps**
- No document types / metadata schemas (contract, decree, regulation, report)
- No lifecycle states (draft → review → approved → published → archived)
- No diff (textual / structural)
- No classification / tagging (manual + AI)
- ~~No legal hold~~ ✅ per-document legal hold (P3.5 / ADR-0050) — folder-level hold still pending
- No DoD 5015.2-style records management
- No digital signatures (eIDAS / PKCS#7)
- ~~No retention policies~~ ✅ folder-inherited + per-doc retention with a soft-delete sweeper (P3.5 / ADR-0050) — hard-purge still pending

**Complexity:** **XL**.

---

## 3.10 Workflow / BPM Engine

| field | value |
|---|---|
| **Status** | NOT STARTED |

No Temporal, no BPMN, no FSM library, no approval tables, no SLA timer, no escalation policies, no visual builder. **Complexity: XL** (Temporal integration alone is a multi-week task; the visual builder + library of workflows is a multi-month team effort).

---

## 3.11 Chat & Messaging

| field | value |
|---|---|
| **Status** | DONE — MVP (P3.12a+b / ADR-0057); membership/presence/CH-projection deferred |

**P3.12a ✅ (channels + messages + realtime):** `chat_channels` + `chat_messages` (author set-null, `edited_at`, soft-delete, feed index, migration 0031, RLS). **Tenant-open** channels (`chat:read`/`write`/`manage`). `ChatService`/Controller — channel create(`manage`)/list/get/delete(cascade); message post(`write`)/list(`before`-cursor)/edit/delete (**author or `chat:manage`**). **Realtime rides P2.3**: every mutation emits a `chat` event to the outbox (atomic) → relay → NATS `tenant.<id>.chat.<eventType>.v1`; `chat→chat:read` in the subject-permission map. real-NATS→WS live smoke.

**P3.12b ✅ (threads + reactions + mentions + web):** threads (`parent_id`, one level; feed top-level + `replyCount`; replies endpoint), reactions (`chat_reactions` unique → idempotent; `{emoji,count,mine}[]` enrichment), mentions (explicit `userId[]` → `chat.mention` notifications); migration 0032. Web `/chat` (sidebar + protected): channel list + stream + composer + emoji reactions + thread panel; **browser polls 4 s** (JWT-over-WS avoided — WS-ticket follow-up). e2e `chat` **8/8**; web `tsc`/`lint`/`build` + 307 smoke. Files: `apps/api/src/modules/chat/`, `apps/web/src/app/chat/`. **Remaining:** membership/private channels, presence/typing/read-receipts, mention-autocomplete UI, CH projection, attachments/search, WS-ticket browser realtime. **Complexity: XL.**

---

## 3.12 Video Conferencing

| field | value |
|---|---|
| **Status** | DONE — MVP end-to-end (P4.2a+b+c / ADR-0061); SFU clustering + calendar + case-detail "start call" deferred |

**P4.2a ✅ (video substrate — LiveKit gated seam + rooms backend + token mint):** `livekit-server-sdk`; config `LIVEKIT_ENABLED`(false)/`_URL`/`_API_URL`/`_API_KEY`/`_API_SECRET`/`_TOKEN_TTL_SECONDS`. **Gated dev containers**: `livekit` (livekit/livekit-server v1.8, `infra/livekit/livekit.yaml` keys match the API) + `coturn` (TURN/STUN) in dev-compose. `video_rooms` table (migration 0035, RLS; standalone with reserved nullable `linked_type`/`linked_id` for later incident/case attachment). Perms `video:read`/`write`/`manage` (operator → read+write, auditor → read). Contracts `video.ts`. `VideoService` (**gated-lazy seam** — `livekit-server-sdk` dynamic-imported): room CRUD; **room-scoped token mint** (`AccessToken` roomJoin grant — pure JWT signing, works without a running SFU so it's e2e-testable; returns an `enabled` flag); `close` (creator or `video:manage`; best-effort SFU `deleteRoom` only when enabled). The SFU room auto-creates on first join, so no admin call is needed to start one. `VideoController` (`/v1/video/rooms` CRUD + `/:id/token` mint + `/:id/close`, all `@Authorize`-gated). **BFF posture:** the browser gets only the short-lived room-scoped LiveKit token, never the platform JWT. e2e `video` **6/6** (room CRUD; token mint + JWT-grant decode; RBAC; tenant isolation/RLS; link both-or-neither; close + closed-room 409). **Live smoke 1/1**: a real LiveKit SFU accepts the dev key via `RoomServiceClient` (validates the livekit.yaml ↔ API key alignment). Suite **55 suites / 404 tests**, zero regressions. Files: `apps/api/src/modules/video/`, `packages/db/src/schema/video-rooms.ts`, `infra/livekit/`.

**P4.2b ✅ (web video rooms + join UI):** Deps `@livekit/components-react`/`-styles` + `livekit-client`. BFF token route `/api/video/token` (attaches the API bearer server-side → `/v1/video/rooms/:id/token`; passes through 403/404/409). Server actions (list/create/close). `/video` page (gated `video:read`, server-fetches rooms) → `VideoWorkspace` (client): open/closed room list, create (`video:write`), close (creator or `video:manage`), **Join** → BFF token → mounts LiveKit's prebuilt `<VideoConference>` (participant grid, device controls, screenshare, leave) via `next/dynamic({ssr:false})` `RoomStage`; graceful "video not enabled" fallback when `enabled:false`. Sidebar "Video" entry enabled + gated on `video:read`; middleware protects `/video`. **BFF:** browser holds only the room-scoped LiveKit token, never the platform JWT. Web `tsc`/`lint`/`build` green; smoke `/video`→307 login + `/api/video/token`→401. Files: `apps/web/src/app/video/`, `apps/web/src/app/api/video/token/`.

**P4.2c ✅ (recording + incident links):** **Recording (manual start/stop):** `video_recordings` (migration 0036, RLS). `VideoService.startRecording` (`video:manage`) issues a LiveKit **RoomCompositeEgress** → MP4 in MinIO at `recordings/<tenant>/<room>/<id>.mp4`; gated → 503 when egress off (the egress S3 target is supplied per-request, internal endpoint). `stop`/`list`/presigned `download` (StorageService). Endpoints `POST /rooms/:id/recordings`, `POST /recordings/:id/stop`, `GET /rooms/:id/recordings`, `GET /recordings/:id/download`. **Egress infra**: `livekit-egress` opt-in compose **profile** (`--profile egress`; heavy headless Chrome) + `infra/livekit/egress.yaml` + redis added to `livekit.yaml`. **Incident links**: `linked_type`/`linked_id` activated — `createRoom` accepts a link, `GET /rooms?linkedType=&linkedId=` filters, incident detail (`/incidents/[id]`) gets a **"Start video call"** affordance + linked-call list → `/video?join=<id>` auto-joins. **Web:** in-call Record/Stop + recording download (`video:manage`); `IncidentVideo` widget. e2e `video` **9/9** (incl. recording gating 403/503 + list + presigned download + cross-tenant 404 + link filter); suite **55 suites / 407 tests**, zero regressions; web `tsc`/`lint`/`build` green. **Boundary:** real WebRTC media + egress aren't headless-tested (manual via the egress profile).

**Follow-ons (ADR-0061):** SFU clustering / multi-node LiveKit (HA); calendar scheduling; case-detail "Start call" (when the case web UI lands); per-participant/track egress + recording retention; Playwright two-browser media smoke. **Complexity: XXL** (operational discipline as much as code).

---

## 3.13 Notification System

| field | value |
|---|---|
| **Status** | P1.6 COMPLETE (phases a–c) |
| **Compl. %** | 60 % (in-app + web center + email + prefs) |

**In-app (P1.6a / ADR-0024):** `notifications` table (recipient-scoped, RLS) + self-scoped center (`GET /notifications` + unread-count + mark-read/read-all, auth-only). Best-effort dispatch from `IncidentsService` on assign (→ assignee) + transition (→ reporter+assignee), actor-excluded, in its own tx (never fails the incident op). 6 e2e, suite 159/159, live-validated.

**Web center (P1.6b / ADR-0024):** topbar bell + unread badge (polls unread-count every 30s) + dropdown of latest 8 (deep-link → mark-read) + "Mark all read"; `/notifications` full page; sidebar entry + middleware. Client → server-actions (token stays server-side), fail-safe. Web build green; suite 159/159.

**Email + prefs (P1.6c / ADR-0024):** `MailService` (Nodemailer/`MAIL_*`, best-effort, dev-logs/prod-drops) + **Mailpit** in compose. **Password-reset now emails** (swapped the P1.3 dev-logger → `EmailResetNotifier`, closing that gap). Email-on-notification (`create` sends + stamps `dispatched_at`). `user_notification_prefs` per-kind (RLS, migration `0011`) applied in dispatch; GET/PUT prefs + web toggle grid. Simple HTML templates. +5 e2e, suite 164/164, live-validated (reset + incident emails in Mailpit).

**P1.6 complete (a–c).** Still future: transactional outbox + worker, event bus, quiet-hours, Web Push/VAPID, webhook delivery, MJML.

**Complexity:** **L** for in-platform + email + webhook; web push and mobile push are individually **M**.

---

## 3.14 Search Engine

| field | value |
|---|---|
| **Status** | NOT STARTED |
| **Compl. %** | 3 % |

Postgres `pg_trgm` extension is installed. Documents list endpoint uses `ILIKE` substring search with proper wildcard escaping — that's the entire search surface. No federated search, no BM25, no faceting, no autocomplete, no saved searches, no permission-aware indexing, no OpenSearch cluster.

**Complexity:** **XL** for the full federated search; **M** for an interim Postgres `tsvector` + GIN approach.

---

## 3.15 Audit & Activity Logging

| field | value |
|---|---|
| **Status** | PARTIAL |
| **Compl. %** | 85 % |
| **Arch.** | 9/10 |
| **Prod.** | 8/10 |
| **Scale** | 7/10 |
| **Sec.** | 8/10 |
| **Code** | `apps/api/src/modules/audit/{audit.service,audit-chain.service,audit.controller}.ts`, `packages/db/src/schema/{audit-log,audit-chain-anchor}.ts`, `0002_rls_policies.sql`, `0012`/`0013` |

**Implemented**
- Append-only table with `tenantId`, `actorId`, `actorType`, `action`, `resourceType`, `resourceId`, `outcome`, `ip`, `userAgent`, `metadata`, `prev_event_hash`, `this_hash`, `occurred_at`
- RLS: insert permissive, select scoped, update/delete only via bypass
- Durable-on-demand writes (`runPrivileged` survives request rollback)
- Audit on login (success/failure/denied), refresh, logout, document init/finalize/download/delete
- `request_id` (P0.3) + `trace_id` (P0.6) populated on every row
- **Tamper-evident hash chain** (P1.11a / ADR-0029): `seq` + async sealer fills `prev_event_hash`/`this_hash` per `(tenant, UTC day)` chain; `verifyChain` pinpoints tampered rows
- **Daily Merkle anchor under S3/MinIO Object Lock (WORM)** (P1.11b): `@nestjs/schedule` cron + `audit_chain_anchor` table; `rootMatches` cross-check; gated verify/seal/anchor endpoints. **Hardened P3.15 / ADR-0059:** HA-safe (`pg_advisory_xact_lock` in `anchorChain` → no double-WORM under N instances), prod COMPLIANCE-mode boot guard, **anchor-gap status** `GET /v1/audit/anchor/status` (per-day anchored/sealed + dropped-day `gaps`); e2e 9/9
- **SIEM export** (P1.12 / ADR-0030): worker tail-reads by durable `seq` cursor (`audit_export_cursor`), ships **RFC 5424 syslog / CEF** via pluggable sink (noop/stdout/file/tcp), at-least-once; gated status/flush endpoints
- **ClickHouse archive + analytics projection** (P2.2 / ADR-0034): cursor-tail ETL (`projection_cursors`) → `cmc.audit_events` + `audit_daily_stats` MV; gated projection status/flush endpoints (live: 160→160)

**Gaps vs ToR §3.15**
- Export side done; a running SIEM (Wazuh/OpenSearch) + managed forwarder (Vector/Fluent Bit) + TLS on the TCP sink → H-tier
- No retention policy enforcement; no legal-hold suspension
- Dedicated `audit:read` permission + auditor role (currently reuses `tenant:manage`)
- `system` (tenant-less) chain verification is privileged-only — no platform-superadmin endpoint yet
- No saved-investigation tooling; reads have no pagination (no audit explorer UI)
- ClickHouse retention/TTL for very old `audit_events` (archive itself done — P2.2)

**Complexity to complete:** ~~hash chain + Merkle anchor~~ ✅ done (P1.11); **S** for SIEM export (P1.12); **L** for the audit explorer UI.

---

## 3.16 Knowledge Base / Wiki

| field | value |
|---|---|
| **Status** | DONE — MVP (P3.10a+b+c / ADR-0055); per-page ACLs, templates, realtime collab (Yjs §3.22) deferred |

**P3.10a ✅:** `wiki_spaces` + `wiki_pages` (ltree tree per space, TipTap/ProseMirror JSON `content` + derived `content_text`, tsvector GIN, migration 0028) + `wiki_page_versions` (snapshot per save); `WikiService`/Controller — space CRUD, page CRUD + tree + move (repath CASE + cycle guard) + soft-delete subtree, version list/restore (append-only); `wiki:read/write/manage`, RLS. e2e 7/7. Files: `apps/api/src/modules/wiki/`, `packages/db/src/schema/wiki-*.ts`, `packages/contracts/src/wiki.ts`. **Complexity: XL.**

**P3.10b ✅:** `wiki_comments` (page_id cascade, `parent_id` self-FK thread, author set-null, body, soft-delete, migration 0029, RLS). `WikiService.listComments`/`createComment` (same-page parent check → 400) / `deleteComment` (author **or** `wiki:manage`, else 403). Endpoints GET/POST `pages/:id/comments` (read/write), DELETE `comments/:id`. e2e `wiki-comments` 4/4 (threading, oldest-first, cross-page-parent 400, author/manager/non-author delete, RBAC + cross-tenant 404).

**P3.10c ✅:** web wiki (TipTap v2 — `@tiptap/react`+`starter-kit`+`pm`). `/wiki` (space cards + create gated on `wiki:manage`) + `/wiki/[spaceId]` three-pane `WikiWorkspace` — page tree nav (ltree-depth indent, inline create root/child), `PageEditor` (`immediatelyRender:false`, remount-on-key + `setEditable`, toolbar, JSON round-trip), tabbed History (restore) / Comments (threaded, reply, author-or-manage delete via `/rbac/me` userId). `"use server"` actions; sidebar "Knowledge Base" enabled; `/wiki` middleware-protected; prose styles in `globals.css`. Validated: web `tsc`/`lint`/`build` clean, 307-redirect live smoke. Files: `apps/web/src/app/wiki/`. **Remaining:** per-page ACLs, templates, real-time collab (Yjs, §3.22), wiki→federated-search wiring. **Complexity: XL.**

---

## 3.17 Integration / API Gateway

| field | value |
|---|---|
| **Status** | PARTIAL (in-app API keys done; gateway not) |
| **Compl. %** | ~40 % |

No Kong / Envoy / WAF yet; the Next.js BFF + Caddy edge are the gateway today. **API keys ✅ (P3.9a / ADR-0054):** `api_keys` (SHA-256 hash, scopes, RLS, migration 0027) + in-app combined auth (`TenantContextMiddleware` resolves `X-API-Key` / `Bearer cmc_…` → api-key principal; `RbacService.resolvePermissions` returns scopes pre-cache → `@Authorize` gates the same `/v1`), per-key + per-tenant Redis quota guard (429), `/v1/api-keys` mgmt (`api_key:manage`, user-only). e2e 8/8. **Web `/admin/api-keys` (P3.9b):** scope picker (from caller's perms), secret-shown-once + copy, list/status, revoke. **OpenAPI doc generation ✅** (P1.10 / ADR-0028): `@nestjs/swagger` + CLI plugin + Zod-contract response schemas served at gated `/v1/openapi.json` + Swagger UI at `/admin/api-docs`. Remaining: outbound webhooks, Kong/Envoy + WAF.

**Complexity:** **L** to add Caddy + a NestJS rate-limit guard + OpenAPI generation; **XL** for the full Kong/Envoy + WAF + quota + analytics surface.

---

## 3.18 AI-Ready Architecture (deep dive §16)

| field | value |
|---|---|
| **Status** | IN PROGRESS (Horizon P5) — substrate landed |
| **Compl. %** | ~52 % (LLM gateway P5.1 + vector P5.2 + semantic search P5.3 + RAG P5.4 + copilots P5.5 + document intelligence P5.6 done) |

**Done:** ✅ LLM gateway + LLM-call (metadata) audit (P5.1 · ADR-0067 — gated OpenAI-compatible seam, per-tenant rate-limit); ✅ vector tables + embedding pipeline (P5.2 · ADR-0068 — `document_embeddings` Postgres `jsonb`, best-effort indexer via the gateway `embed()`); ✅ semantic search (P5.3 · ADR-0069 — brute-force vector kNN fused into `/v1/search` by RRF, permission-aware); ✅ RAG framework (P5.4 · ADR-0070 — strictly-grounded, cited, audited `/v1/rag/ask`); ✅ per-module copilots (P5.5 · ADR-0071 — read-only, module-scoped, record-anchored `/v1/copilot/ask`; framework + Incidents); ✅ document intelligence / OCR (P5.6 · ADR-0072 — gated PDF text-layer + Tesseract extraction → OpenSearch `content` + re-embed). **Remaining:** classification + structured extraction; chunking; async embedding workers; pgvector ANN / Qdrant at scale; action-capable copilots. **Complexity: XXL.**

---

## 3.19 Administration Panel

| field | value |
|---|---|
| **Status** | P1.4 COMPLETE (phases a–d) |
| **Compl. %** | 60 % (foundation + Users + Roles + Tenant settings) |

**Foundation (P1.4a / ADR-0022):** `GET /rbac/me` (current user's effective roles+permissions, self-scoped) drives a gated `/admin` section — `getMyAccess()` (fail-closed, request-memoised) + an `/admin` layout redirect for non-admins + the now-enabled "Administration" sidebar entry + middleware protection + an `/admin` overview. The API stays the real authz boundary (every admin endpoint `@Authorize`-gated); the web redirect is UX.

**Users (P1.4b):** `GET/POST/PATCH/DELETE /users` (`user:manage`, RLS → cross-tenant 404) + `/admin/users` (list, create form, per-row activate/deactivate, reset-password-reveal, delete, role add/remove). Passwordless invite → admin-reset (P1.3) sets the first password (no email yet). Deactivate/delete revoke sessions + block re-login; self-deactivate/delete guarded. `SessionsService` extracted to `SessionsModule` to avoid the Auth↔Users DI cycle. Audited. 11 e2e; suite 126/126; web build green; live-validated.

**Roles (P1.4c):** `role:manage` perm + `GET /rbac/permissions` + `GET/POST/PATCH/DELETE /rbac/roles`. System roles immutable (403 on edit/delete); custom-role slug+perm validation (409/400); perm-cache `delTenant` on permission change/delete. `/admin/roles` editor (create + inline edit w/ domain-grouped permission picker; system read-only). 7 e2e; suite 133/133; live-validated.

**Tenant settings (P1.4d):** `tenant:manage` perm + `GET/PATCH /tenant` (rename own tenant) + method-gated `PUT /branding` (localeDefault/logoUrl/copy, copy-merge upsert; `GET /branding` stays public). `/admin/tenant` Identity + Branding forms. 7 e2e; suite 140/140; live-validated.

**P1.4 complete (a–d).** Remaining for a "full" admin console (beyond P1.4 scope): cross-tenant platform-superadmin administration; step-up re-auth for destructive actions; feature flags / quotas / SSO+SMTP config. Deferred by decision. **Complexity (done): L.**

---

## 3.20 Monitoring & Observability (deep dive §14)

| field | value |
|---|---|
| **Status** | IN PROGRESS (logs + metrics + traces triangle closed) |
| **Compl. %** | 55 % |

Structured JSON logging with `request_id`+`trace_id`+`tenantId`+`userId` (P0.3 / ADR-0010); OTEL traces + trace_id-in-logs (P0.6 / ADR-0013); Prometheus RED metrics + Grafana dashboard (P0.7 / ADR-0014); health probes (P0.8 / ADR-0015); **Loki log aggregation** (pino-loki API + Promtail containers + request_id dashboard, P1.7 / ADR-0025); **Tempo traces + three-signal cross-link** (Loki→Tempo on `traceId`, Tempo→Loki via `tracesToLogsV2`) + **Alertmanager** with a 5xx-ratio rule + target-down rule (P1.8 / ADR-0026). The whole stack is `pnpm obs:up`.

**Remaining:** alert **delivery/paging** (Alertmanager receiver is a no-op until a paging target / platform-superadmin recipient exists), Prometheus exemplars (metric→trace jump), log-based metrics, tail sampling, production object-store Tempo/Loki + non-root Tempo. **Complexity:** **L** done; **XL** at proper SRE quality.

---

## 3.21 Data Import/Export

| field | value |
|---|---|
| **Status** | PARTIAL — import side done (P3.11a+b / ADR-0056); export side + CDC/scheduler next |

**P3.11a ✅ (import backend):** gated BullMQ import queue + worker (`IMPORTS_ENABLED`) — **CSV→incidents** (`csv-parse`) + **GeoJSON→GIS features** (`ST_GeomFromGeoJSON`). `import_jobs` + `import_row_errors` (quarantine) + migration 0030 + RLS. **Per-row validation with partial-commit + quarantine** (zod for incidents / structural for geometry; each insert in a SAVEPOINT so one bad row can't abort the job; counts + status atomic). `create` gates on the **target-domain write perm** (no RBAC escalation); `runJob` compare-and-set claim (queued→processing) so a retry can't double-import. `import:run`/`import:read`. e2e + real-BullMQ live smoke.

**P3.11b ✅ (Excel + Shapefile + web):** two new kinds reusing the pipeline (parsers dynamic-imported) — **`xlsx_incidents`** (`xlsx`/SheetJS, first sheet) + **`shapefile_gis`** (`adm-zip` → `shapefile.read` → GeoJSON; WGS84 assumed). `ImportService` split into parsers vs processors. **`POST /v1/imports/upload-init`** presigns a PUT (transient `imports/<tenant>/…` source, no document row). **Web `/imports`** (sidebar + middleware-protected): job table + expandable quarantine viewer + new-import form (upload-init → presigned PUT → create) via server actions. e2e `imports` **8/8** (incl real hand-built `.shp` zip + upload round-trip); web `tsc`/`lint`/`build` + 307 smoke. Files: `apps/api/src/modules/imports/`, `apps/web/src/app/imports/`. **Remaining:** export side, dedupe/upsert, user-defined field mapping, proj4 reprojection, CDC/scheduler, resumable-job reaper. **Complexity: XL.**

---

## 3.22 Realtime Collaboration

| field | value |
|---|---|
| **Status** | DONE — MVP end-to-end (P4.1a+b+c / ADR-0060); multi-instance Hocuspocus + realtime comment push deferred |

**P4.1a ✅ (collab substrate — Hocuspocus seam + Yjs persistence + wiki snapshot):** `collab_docs` table (one row per Hocuspocus doc `name` e.g. `wiki.<pageId>`, `state bytea` = `Y.encodeStateAsUpdate`, tenant-cascade, RLS; migration 0033). **Gated-lazy-seam** `CollabServer` (dedicated WS, separate from the P2.3 broadcast plane) — `@hocuspocus/server` + `yjs` dynamic-imported so they never enter jest; started **solely** on `HOCUSPOCUS_ENABLED` (defaults false → off in the default suite; the usual `NODE_ENV==='test'` skip is intentionally dropped so the live smoke can boot the real server under a light test-mode app). `CollabService` (decoupled, fully e2e-testable without the WS): `authorize` (verify JWT HS256+issuer → page-in-tenant → `wiki:write`), `loadDocument` (stored `Y.Doc`, else seed from the page's current TipTap JSON via `TiptapTransformer.toYdoc`), `storeDocument` (debounced — persist bytes **and** snapshot back to `wiki_pages.content` + derived plaintext so search / non-collab reads / versions stay current). Config: `HOCUSPOCUS_ENABLED`/`_PORT`(3002)/`_SNAPSHOT_DEBOUNCE_MS`(2000). e2e `collab` **3/3** (authorize 5-case; load seeds from wiki; store persists + snapshots + reload). **Headless live smoke 1/1**: two real `@hocuspocus/provider` Node clients connect to `wiki.<pageId>` → edit in one CRDT-syncs to the other → server snapshots to the wiki page. Files: `apps/api/src/modules/collab/`, `packages/db/src/schema/collab-docs.ts`. **BFF posture:** the browser gets a short-lived WS ticket, never the raw access JWT (delivered in P4.1b).

**P4.1b ✅ (web collaborative wiki editor — TipTap Collaboration + cursors):** **WS-ticket plane (BFF — browser never holds the access JWT):** `POST /v1/collab/ticket` (`@Authorize("wiki:write")` + per-page tenant check → 403/404) mints a **single-use, short-lived Redis ticket** (`collab:ticket:<rand>`, TTL `HOCUSPOCUS_TICKET_TTL_SECONDS`=60); the WS handshake `authorizeConnection` tries `consumeTicket` (GETDEL → single-use) then falls back to JWT (tests/live-smoke). Contracts `collab.ts`; config `HOCUSPOCUS_PUBLIC_URL` + `…_TICKET_TTL_SECONDS`. **Web:** BFF route `/api/collab/ticket` (attaches bearer server-side); `CollabPageEditor` = TipTap `Collaboration` (StarterKit history off) + `collaboration-cursor` + `@hocuspocus/provider` bound to a `Y.Doc`, a fresh ticket fetched per (re)connect via the provider `token` function, presence cursors (CSS in globals.css). `WikiWorkspace` **auto-collab with manual fallback**: Edit → connect; live → "● Live · N editing" badge + "Done" (body auto-persists via Hocuspocus; title rename = title-only PATCH leaving collab content untouched); on feature-off/no-perm/unreachable → the existing save-based `PageEditor`. Deps (pinned, single yjs): `@tiptap/extension-collaboration`/`-cursor` 2.27.2, `@hocuspocus/provider` 2.15.3, `yjs` 13.6.31. e2e `collab` **8/8** (ticket mint / consume / single-use / doc-binding / dual-path); the live smoke now also proves the **ticket** path over the real WS; web `tsc`/`lint`/`build` green; suite **54 suites / 397 tests**, zero regressions. Files: `apps/api/src/modules/collab/collab.controller.ts`, `apps/web/src/app/wiki/[spaceId]/collab-page-editor.tsx`, `apps/web/src/app/api/collab/ticket/`.

**P4.1c ✅ (anchored comments + offline reconcile):** Anchored comments **extend `wiki_comments`** (migration 0034): nullable `anchor` (encoded Yjs relative positions `{from,to}` via `y-prosemirror` — auto-rebase as text is edited) + `anchor_text` (quoted snapshot). Reuses RBAC / notifications / audit / the threaded comment panel; queryable + durable even when collab is off; top-level only (a reply's anchor is dropped). **Web:** `comment-anchor.ts` (encode the current selection / resolve an anchor → absolute range via the y-prosemirror binding), `CommentHighlight` TipTap extension (ProseMirror decorations recomputed every transaction so highlights track edits; click a highlight → flash the comment), a **floating "💬 Comment" bubble** on text selection, and the panel renders a 📌 quoted snippet + flashes the active comment. **Offline reconcile** via `y-indexeddb` (offline edits persist + merge on reconnect; "Offline — saved locally" pill). Deps (pinned): `y-prosemirror` 1.3.7, `y-indexeddb` ^9. e2e `wiki-comments` **5/5** (anchor + snapshot round-trip; anchors ignored on replies); suite **54 suites / 398 tests**, zero regressions; web `tsc`/`lint`/`build` green. **Coverage boundary:** the in-browser relative-position encode/decode + decorations are covered by build + the backend anchor round-trip (a Playwright two-browser test is a follow-on). Files: `apps/web/src/app/wiki/[spaceId]/{comment-anchor,comment-highlight}.ts(x)`, `packages/db/src/schema/wiki-comments.ts`.

**Follow-ons (ADR-0060):** multi-instance Hocuspocus (Redis-backed) for HA; push anchored-comment changes to live collaborators (ride P2.3) instead of refetch; collaboration for dashboards / workflow diagrams; Playwright two-browser test. **Complexity: XL** (specialised area).

---

## 3.23 Task & Case Management

| field | value |
|---|---|
| **Status** | NOT STARTED |

**Backend done (P2.10 / ADR-0040):** `cases` + `case_activity` (state machine, priority+CHECK, assignee, `due_at`, soft-delete, RLS); `/v1/cases` CRUD + transition (resolve-gate) + assign + **comment/activity timeline** + stats; tenant-scoped, audited, outbox events; `case:*` RBAC. **SLA escalation now durable** — `due_at` drives a Temporal timer auto-started/cancelled by the case lifecycle (P3.1 / ADR-0045), escalating to a `sla_breached` activity + `case.sla_breached` event on breach. **Remaining:** web UI (dashboard "Cases Open 142" still hardcoded), config-driven case types, assignment policies, linked artifacts (incident/document/gis_feature), `case_number`, case events consumer. **Complexity (done): L; remaining: L.**

---

## 3.24 Media Management

| field | value |
|---|---|
| **Status** | ✅ DONE — substrate + web player + watermark (P4.5a+b+c; ADR-0063) |

**P4.5a ✅ (media substrate — gated FFmpeg→HLS transcode + BFF stream proxy):** new `media:read`/`media:write` (operator+auditor). `media_assets` (FK documents, kind/status/playlist_key/poster_key/duration; RLS; migration 0037). **Gated BullMQ `media-transcode` seam** (`MEDIA_TRANSCODE_ENABLED`; `bullmq`/`ioredis` dynamic-imported) + worker (isTest-skipped) → `MediaService.transcode` shells out to **ffmpeg → HLS → S3** (`media/<tenant>/<asset>/index.m3u8` + segments + poster); the SFU... source is an uploaded **document** (P2.12/P3.4). Contracts `media.ts`. `MediaService`: `requestTranscode` (document → pending asset + enqueue), list/get, and the **BFF HLS proxy** — `getPlaylist` (rewrites segment URIs → `seg/<name>`) + `getSegment` (proxies `.ts` bytes, regex-guarded against traversal). `MediaController` `POST /v1/media/transcode` + `GET /assets`, `/assets/:id`, `/assets/:id/playlist.m3u8`, `/assets/:id/seg/:name` (StreamableFile), all `@Authorize`. **BFF**: the player streams through per-request RBAC-checked endpoints — no JWT in the browser, no public S3 URLs. e2e `media` **3/3** (transcode→pending + list/get; RBAC + unknown-doc/cross-tenant 404; HLS playlist-rewrite + segment bytes + invalid-name 400 + cross-tenant 404). Suite **57 suites / 415 tests**, zero regressions. **Boundary:** real ffmpeg→HLS isn't headless-tested (worker gated off in tests; the proxy is tested against HLS seeded in MinIO). Files: `apps/api/src/modules/media/`, `packages/db/src/schema/media-assets.ts`.

**P4.5b ✅ (web media + HLS player):** `hls.js`. **BFF HLS proxy routes** `/api/media/[id]/playlist.m3u8` + `/api/media/[id]/seg/[name]` (bearer attached server-side → API; player streams same-origin, no JWT in browser). `/media` page (gated `media:read`) → `MediaWorkspace`: asset list + status badges (polls 5s while pending/processing), "Make streamable" (documentId → `requestTranscode`), and `MediaPlayer` (`hls.js`, dynamic ssr:false, native-HLS fallback) over the proxied playlist. Sidebar "Media" entry (replaced disabled "Files"), gated; middleware protects `/media`. Web `tsc`/`lint`/`build` green; smoke `/media`→307 + playlist proxy→401. Files: `apps/web/src/app/media/`, `apps/web/src/app/api/media/`.

**P4.5c ✅ (watermarking + close):** optional **burned-in text watermark**. `media_assets.watermark` (migration 0038, no RLS change), `CreateMediaTranscodeSchema.watermark` (≤100 chars) + `MediaAssetSchema.watermark` (nullable). `MediaService.transcode` adds an ffmpeg **`drawtext`** filter (`-vf drawtext=…`, bottom-left, semi-transparent white on a dark box) when set — text **shell-escaped for the filtergraph** (`\ ' : %`); optional `MEDIA_WATERMARK_FONT` → `fontfile` (drawtext needs a font; default ffmpeg built-in). Burned into pixels → survives download/screen-capture (unlike a player overlay). `MediaController` parses the full schema → `requestTranscode(actor, documentId, watermark?)`. **Web**: watermark `<input>` on the "Make streamable" form → `requestTranscodeAction(documentId, watermark?)`. e2e `media` **4/4** (added watermark round-trip: provided→stored, omitted→null). Suite **57 suites / 416 tests**, zero regressions; eslint clean; web `tsc`/`lint`/`build` green; smoke `/media`→307 + playlist proxy→401. **ADR-0063** covers P4.5 a–c. **Boundary:** real ffmpeg watermark burn-in is manual/live (worker gated off in tests). **P4.5 closed.**

**Follow-ons:** multi-bitrate ABR ladder; document-picker integration on the documents page (today a document ID is entered directly); per-tenant watermark presets (logo/position/opacity); derived-rendition retention. **Complexity: L.**

---

## Regional Segmentation (P4.6)

| field | value |
|---|---|
| **Status** | ✅ DONE — substrate + hard scoping + web (P4.6a/b/c; ADR-0064) |

**Reframed 2026-06-03:** "P4.6 Multi-region DR" → **regional segmentation**. Single-site deployment (server + backups at the head office) ⇒ no physical multi-region DR (cross-DC replication / regional Tempo+Loki / DNS failover out of scope; **off-site backup** = follow-on). "Region" = a logical division of users + operational data *within* the tenant; regional users see only their own region, the head office (`region:all`) sees all. Decisions (2026-06-03): region inside the tenant; **hard** separation + HQ-sees-all; **incidents+cases** scope first; **seed TJ regions + admin CRUD**.

**P4.6a ✅ (regions substrate):** perms `region:read`/`region:manage`/`region:all` + system role **`hq`** (region:read + region:all); operator/auditor get region:read, tenant_admin via `*`. `regions` table (per-tenant code+name, unique (tenant,code), RLS, migration 0039) + `users.region_id` (FK regions, set-null). Contracts `region.ts` + `DEFAULT_TJ_REGIONS` (Душанбе / Согд / Хатлон / ГБАО / РРП). `RegionsService` + `RegionsController`: `GET /v1/regions` (region:read), create/update/delete (region:manage; delete → 409 if users assigned). User→region via the existing `PATCH /v1/users/:id` (`regionId`, in-tenant-validated → 404 if unknown). `ensureDefaultRegionsForTenant` wired into dev seed + e2e fixtures. e2e `regions` **5/5** (seed+RBAC; create/dup/bad/operator; update/cross-tenant; assign/clear/unknown; delete-guard). Suite **58 suites / 421 tests**, zero regressions (rbac role-set assertions updated for `hq`). Files: `apps/api/src/modules/regions/`, `packages/db/src/schema/regions.ts`.

**P4.6b ✅ (hard region scoping on incidents + cases):** `region_id` (FK regions, set-null) on incidents + cases (migration 0040; separate from the incidents free-text `region` label; RLS unchanged). `RegionScopeService.current()` → `{ seeAll, regionId }` (seeAll for `region:all` / API-key / no-context; else `users.region_id`); `regionScopeCondition()` → `region_id IS NOT DISTINCT FROM $::uuid`. Applied to incidents `list`/`getDetail`/`stats` + cases `list`/`getDetail`/`stats`/`listActivity`/`addComment` (out-of-region detail/mutation → 404 via the scoped getDetail). `create` stamps the creator's region; `regionId` exposed on Incident/Case summaries. e2e `region-scoping` **3/3**. Suite **59 suites / 424 tests**, zero regressions. **Follow-on:** monitoring wall (P4.3) + ClickHouse analytics (P2.6) not yet region-scoped (HQ-oriented aggregates). Files: `apps/api/src/modules/regions/region-scope.service.ts`.

**P4.6c ✅ (web + close):** `/admin/regions` (CRUD, gated `region:manage`) + admin-overview card; user→region assignment on `/admin/users` (dropdown → `PATCH /v1/users/:id`, new Region column); incidents structured-region **badge** (list + detail) + **zone filter** (new `GET /v1/incidents?regionId=` filter, composes with scope); shared `lib/regions.ts`. **ADR-0064** covers P4.6 a–c. Web `tsc`/`lint`/`build` green; smoke `/admin/regions`→307. Files: `apps/web/src/app/admin/regions/`, `apps/web/src/lib/regions.ts`, `apps/web/src/app/incidents/`. **P4.6 closed.**

**Follow-ons:** region-scope the monitoring wall (P4.3) + ClickHouse analytics (P2.6); cases web UI (+ region badge/filter there); HQ region-picker on create; consolidate incidents free-text `region` → `region_id`; off-site backup (single-site DR carry-over). **Complexity: L.**

---

## 3.25 Geospatial Analytics

(Sub-scope of §3.4 / §4.) **NOT STARTED.**

---

## 3.26 Operational Monitoring Center

| field | value |
|---|---|
| **Status** | DONE — MVP end-to-end (P4.3a+b+c / ADR-0062); WS-push + ClickHouse counts + multi-monitor presets deferred |

**P4.3a ✅ (monitoring backend — summary snapshot + audit_log replay):** new `monitoring:read` perm (operator + auditor + tenant_admin). Contracts `monitoring.ts`. `MonitoringService` — **pure Postgres aggregation** (RLS-scoped; deliberately no ClickHouse dependency so the wall is always available + e2e-testable): `summary()` returns a live snapshot — incidents `active` + `byStatus` + `bySeverity`, `recentIncidents` (8), `recentEvents` (20, from `audit_log` — the alert-ticker feed), open video-room count, `generatedAt`; `replay(from,to,limit)` returns the `audit_log` operational action timeline over a window, ascending, capped at 2000. `MonitoringController`: `GET /v1/monitoring/summary` (polled by the wall) + `GET /v1/monitoring/replay?from=&to=&limit=`, both `@Authorize("monitoring:read")`. e2e `monitoring` **5/5** (summary counts + recent events; replay window + ascending order; bad-window 400; RBAC 403; tenant isolation — another tenant sees 0). Suite **56 suites / 412 tests**, zero regressions. Files: `apps/api/src/modules/monitoring/`.

**P4.3b ✅ (web wall view + alert ticker):** `/monitoring` page (gated `monitoring:read`, server-fetches the summary) → `MonitoringWall` (client) **polls `/monitoring/summary` every 4s** (server action) with a live/stale indicator. KPI tiles (active incidents, SEV-1 critical, open calls, recent-event count), by-severity bars + by-status counts, recent-incidents list (links to `/incidents/[id]`), and a live **alert ticker** (recentEvents — outcome dot + time + action + resourceType). Lifted the disabled **"Command Center"** sidebar entry → `/monitoring`, gated `monitoring:read`; middleware protects `/monitoring`. Web `tsc`/`lint`/`build` green; smoke `/monitoring`→307 login. Files: `apps/web/src/app/monitoring/`.

**P4.3c ✅ (time-replay scrubber):** `ReplayPanel` on `/monitoring` — datetime-local window picker loads `/monitoring/replay`, then a scrubber (range slider) + **Play/Pause** auto-advance steps through the `audit_log` timeline as it happened (current-time readout + a sliding 40-event feed with the current event highlighted). Web `tsc`/`lint`/`build` green. Files: `apps/web/src/app/monitoring/replay-panel.tsx`.

**Follow-ons (ADR-0062):** WS-push (P2.3 WS-ticket) for instant tiles/ticker; ClickHouse-backed counts/trends for very large tenants; map snapshot tile + multi-monitor layout presets; replay overlay on the map / incident timeline. **Complexity: XL** (reuses §3.27 incidents, §3.15 audit, §3.12 video, §3.6 events).

---

## 3.27 Incident / Event Management

| field | value |
|---|---|
| **Status** | P1.5 COMPLETE (phases a–c) |
| **Compl. %** | 55 % (backend + operator UI + live dashboard) |

**Backend (P1.5a / ADR-0023):** `incidents` table (severity 1-5, status, free-text type/region/source, summary/description, optional lat/lng, occurred_at, reported_by/assigned_to, resolved_at, soft-delete) under RLS. Status **state machine** (reported→triaged→in_progress→resolved→closed +cancelled, reopen) shared API↔web via `INCIDENT_TRANSITIONS`. 6 `incident:*` permissions (resolve gated above write). CRUD + list/filters/pagination + assign + stats. Audited. 11 e2e, suite 151/151, live-validated.

**Web (P1.5b / ADR-0023):** `/incidents` list (filter bar→URL params, paginated table, gated report form) + `/incidents/[id]` detail with a state-machine-aware Actions panel (reachable transitions only; resolve hidden without `incident:resolve`), member-dropdown assign, inline edit, gated delete. `GET /incidents/assignees`. Nav + middleware wired. Suite 152/152; web build green.

**Dashboard (P1.5c / ADR-0023):** the operational dashboard's incident widgets (hero counts, KPI strip, Active-by-Region/Type bars, Priority Incidents) read `GET /incidents/stats` + `GET /incidents?active=true` (new `active` filter); hardcoded arrays removed; fail-safe. Suite 153/153; live-validated.

**P1.5 complete (a–c).** Still future: severity-driven SLA/auto-escalation, per-incident activity timeline, command roles (Commander/Comms/Ops), post-mortem template, MTTD/MTTR analytics, real geometry (GIS module). **Complexity (done): L–XL.**

---

## Cross-cutting infrastructure trackers

### Event plane (NATS JetStream)

| | |
|---|---|
| Status | PARTIAL (P2.1 / ADR-0031) — outbox + relay + first producer done; consumers next |
| Files | `apps/api/src/modules/events/{outbox.service,relay.service,event-publisher,nats-event-publisher,events.controller}.ts`, `packages/db/src/schema/outbox.ts` (0015), `packages/contracts/src/events.ts`, `infra/docker-compose.yml` (nats) |
| Done | NATS JetStream container; **transactional `outbox`** (atomic write via ambient tx — no dual-write); **relay** → `tenant.{id}.{aggregate}.{event}.v{n}` (at-least-once, JetStream msgID dedup, advisory-locked); `EventPublisher` seam (real NATS lazy-imported only when enabled); **incidents producer** (created/transitioned/assigned); **first durable consumer** — notifications-from-events (P2.4 / ADR-0032: `consumed_events` dedup ledger, `DeliverPolicy.New`, handler/subscriber split, zero-regression inline fallback). Live-validated end-to-end + trace-correlated |
| Remaining | dead-letter / max-deliver, outbox + consumed_events pruning, WebSocket fan-out (P2.3b — gateway scaffolded P2.3a), multi-worker scale |
| Blocks | §3.6, §3.13, §3.20, §3.22, §3.26, §3.27, audit projection, geofence-trigger, etc. |

### Analytics plane (ClickHouse)

| | |
|---|---|
| Status | PARTIAL (P2.5/P2.2/P2.6) — single-shard CH + 2 projections + MVs + query API |
| Files | `apps/api/src/modules/analytics/{clickhouse.client,clickhouse-client.impl,incident-projection.consumer,incident-projection.subscriber,audit-projection.service,dashboard-analytics.service,dashboard-trend,analytics.controller,analytics.module}.ts`, `infra/clickhouse/init/{01-schema,02-audit}.sql`, `infra/docker-compose.yml` (clickhouse) |
| Done | ClickHouse container (HTTP 8123); incident schema (`incident_events` + daily-by-region MV) + audit schema (`audit_events` + daily-stats MV); gated lazy `@clickhouse/client`; **incident projection consumer** (event-bus, DeliverPolicy.All, dedup ledger — P2.5/ADR-0033) + **audit projection** (cursor-tail ETL, `projection_cursors` — P2.2/ADR-0034). Both live-validated end-to-end. **Query API**: `DashboardAnalyticsService` + `GET /v1/analytics/dashboard` (tenant-scoped CH incident trend, gap-filled, `incident:read`) → web dashboard `TrendChart` (P2.6/ADR-0036) |
| Remaining | more MVs/widgets (by-region trend, audit activity, MTTR), saved reports, parameterised CH bindings, CH migration tooling, sharding/replication (H-tier), retention/TTL |
| Blocks | §3.5, dashboards, audit-archive, position-history queries |

### Search plane (Postgres FTS interim → OpenSearch)

| | |
|---|---|
| Status | FEDERATED (P3.7 / ADR-0052) — OpenSearch docs + Postgres FTS incidents/cases |
| Done | GIN `to_tsvector('simple')` indexes on incidents/cases/documents (migration 0020). `GET /v1/search` now fans out: documents via OpenSearch when enabled (FTS fallback), incidents/cases via `websearch_to_tsquery`+`ts_rank`; **fused by Reciprocal Rank Fusion** (k=60) so BM25 vs ts_rank scales don't fight. Per-domain RBAC + RLS. Documents domain folder-access filtered + `status='ready'` (closed the P2.11 leak of restricted-folder titles). `SearchResult.source` flag. |
| UI | Web `/search` page (P3.7b): server-component query → grouped-by-type results with source badges; sidebar entry + protected route |
| Remaining | Stemming/fuzzy/per-language; highlight (`ts_headline` / OpenSearch highlight); more domains (messages, wiki); CH-aggregated facets; hybrid BM25+vector; command-palette quick-search |
| Files | `apps/api/src/modules/search/{search.service,search.controller,search.module,search-index*}.ts`, `packages/contracts/src/search.ts`, `apps/web/src/app/search/{page,search-box}.tsx` |

### Search plane (OpenSearch)

| | |
|---|---|
| Status | DOCUMENT SEARCH DONE (P3.6 / ADR-0051) |
| Done | Gated-lazy `SEARCH_INDEX` seam (`modules/search/search-index{,.impl}.ts`): Noop unless `OPENSEARCH_ENABLED`, real driver dynamic-imported (never in jest). `opensearch` compose service (2.17.1 single-node) + `opensearch_data` volume + `OPENSEARCH_*` config. `cmc-documents` index (keyword/text/date mapping) ensured at boot. **Indexer (P3.6a):** best-effort in `DocumentsService` (index on finalize/multipart-complete/version-finalize/version-restore/move; unindex on soft-delete; never blocks the write path) + `reindex` backfill (`POST /v1/documents/reindex`). **Search (P3.6b):** `GET /v1/documents/search` (`multi_match` name^2/description, `term tenantId`) → post-filter + RLS-scoped hydration via `FolderAccessService.documentListCondition` (restricted subtrees + cross-tenant ids drop) → re-sorted to OpenSearch score order; Postgres `list` fallback when index off (`backend` flag). e2e (faked seam) + live smoke (real OpenSearch: ranking name^2, tenant isolation, descending scores, delete). |
| Remaining | Federated `/v1/search` fan-out (P3.7); messages/other domains; hybrid BM25+vector; highlight; stemming/fuzzy/per-language; content extraction (Tika/OCR); durable/outbox indexer; search UI |
| Blocks | §3.14, parts of §3.8/§3.9 |
| Complexity | L to deploy + index documents/messages; XL for permission-aware indexing + hybrid BM25+vector |

### Vector plane (Postgres jsonb → pgvector / Qdrant)

| | |
|---|---|
| Status | ✅ IN USE (P5.2 · ADR-0068 — 2026-06-03): `document_embeddings` (Postgres `jsonb`, RLS) populated best-effort from the document lifecycle via the LLM-gateway `embed()`. See **AI / Vector pipeline (P5.2)** above |
| Reframe | Vectors stored as Postgres `jsonb` (no extension, no container) on the PostGIS image — **pgvector ANN index / Qdrant is the scale follow-on** (swaps in without changing the pipeline) |
| Blocks | §3.18 / §16 — unblocks P5.3 semantic search |
| Complexity | done (jsonb store + indexer, L); M for the pgvector ANN index; L to migrate to Qdrant when scale demands |

### Realtime plane (WebSocket gateway)

| | |
|---|---|
| Status | DONE (P2.3 / ADR-0035 — 2026-06-02) — single-instance |
| Done | `RealtimeModule` in `apps/api` (in-process, not a separate app — reuses JwtService/RBAC/NATS/config). Native `ws`, `noServer` server on the HTTP `upgrade` event (gated `REALTIME_ENABLED`); **auth-before-handshake** (`WsAuthService`: JWT verify + session-active; `cmc-bearer` subprotocol or `?access_token=`). JSON protocol (`@cmc/contracts/realtime`); **tenant-isolated + fail-closed per-subscription RBAC** subscriptions (perms resolved at connect), NATS-style matcher, in-memory registry. `RealtimeFanoutSubscriber` (ephemeral JetStream, `DeliverPolicy.New`, `tenant.>` → `broadcast()`). `GET /v1/realtime/status`. 14 tests; full-chain live smoke (POST incident → WS event). |
| Remaining | browser client hook/UI (with P2.6); **Redis pub/sub** cross-instance fan-out (multi-instance); mid-connection RBAC-revocation; presence/optimistic-updates (§7.3/§7.5) |
| Files | `apps/api/src/modules/realtime/{realtime.gateway,realtime-registry.service,realtime-fanout.subscriber,ws-auth.service,subject-match,subject-permission,realtime.controller,realtime.module}.ts`, `packages/contracts/src/realtime.ts` |
| Blocks | §3.11, §3.22, §3.26 |
| Complexity | L (gateway done; Redis pub/sub fan-out = the remaining scale piece) |

### Redis substrate (cache / queue / pub-sub host)

| | |
|---|---|
| Status | DONE (client wired) — 2026-05-25, P0.2, ADR-0008 |
| Files | `apps/api/src/modules/redis/{redis.tokens.ts, redis.module.ts, redis-keys.ts}` |
| Library | `ioredis@^5.4.1` |
| Consumers | **P2.13 BullMQ preview queue + worker** (`cmc-previews`, gated on `PREVIEWS_ENABLED`, ADR-0043). Queued: P0.1 rate-limit, P0.4 session cache, P1.6 notifications, P2.1 NATS-adjacent, P2.3 WS pub/sub |
| Test | `apps/api/test/e2e/redis.e2e-spec.ts` — 4 tests; ping, set/get TTL, GETNAME, status |
| Observability today | NestJS Logger on connect/ready/reconnecting/end/error |
| Deferred to | P0.7 metrics · P0.8 deep health probe |

### Workflow plane (Temporal)

| | |
|---|---|
| Status | DONE (P3.1 / ADR-0045 — case SLA; P3.2 / ADR-0046 — incident response) — 2026-06-02 |
| Files | `apps/api/src/modules/temporal/` (`temporal-client{,.impl}.ts`, `case-sla.scheduler.ts`, `temporal.worker.ts`, `temporal.module.ts`, `workflows/case-sla.workflow.ts`, `activities/case-sla.{types,activities}.ts`); `infra/docker-compose.yml` (`temporal` auto-setup + `temporal-ui`); `TEMPORAL_*` config |
| How | Gated in-process worker (decision: not a separate process). `TEMPORAL_CLIENT` seam (Noop/Real, dynamic-imports `@temporalio/client`); worker dynamic-imports `@temporalio/worker`, bundles `./workflows` (determinism-safe), runs activities built from DI. Off by default → noop client + no worker (jest never loads Temporal) |
| First workflow | **`caseSlaWorkflow`** — sleep until `cases.due_at`, escalate if still open (idempotent activity → `sla_breached` case_activity + `case.sla_breached` outbox event), cancellable. `CaseSlaScheduler.schedule/cancel` (one-per-case workflow id) |
| Tests | `apps/api/test/e2e/temporal.e2e-spec.ts` — 5 (faked client: gating + scheduler→client + cancel). Live smoke (real Temporal): escalate path → `escalated` + activity + outbox; cancel path → `cancelled`, no escalation |
| Gotcha | auto-setup binds the frontend to the container IP, not loopback → healthcheck addresses the service name. Reuses the existing Postgres (DBs `temporal` + `temporal_visibility`) |
| Visual builder (P3.8 / ADR-0053) | **DONE (MVP) — 2026-06-02.** P3.8a: `workflows` table (DAG `definition` JSONB, RLS, migration 0025) + `workflow.ts` contracts (node-type union + `validateWorkflowDefinition`) + `workflow:*` + CRUD/validate. P3.8b: **generic interpreter** — one determinism-safe Temporal workflow walks any DAG (start/end/delay/condition in-workflow; notify/create_incident activities); `workflow_runs` (snapshot + status, migration 0026); `startRun`/`run` + `POST /workflows/:id/run` + run-status. P3.8c: event triggers — `WorkflowEvent{Consumer,Subscriber}` (durable JetStream `workflow-trigger`, dedup) → `findEnabledEventWorkflows`+`startTriggeredRun`. P3.8d: **React Flow `/workflows` editor** (`@xyflow/react`: palette, edges, node config, validate/save/run + runs panel) + list + sidebar + protected route. e2e (3 suites) + 2 live smokes (real worker: manual + event-triggered runs complete) + web runtime smoke. Deferred: loops/parallel/sub-workflows/human-approval/HTTP nodes, run-step viz. Files: `apps/api/src/modules/workflows/`, `apps/api/src/modules/temporal/{workflows,activities}/workflow-interpreter.*`, `packages/db/src/schema/workflow{,-runs}.ts`, `packages/contracts/src/workflow.ts`, `apps/web/src/app/workflows/` |
| Lifecycle wiring (P3.1b) | `CaseSlaScheduler` driven by CasesService: create-with-`due_at` → schedule; update → schedule/cancel on `due_at` change; transition → cancel on leaving open / reschedule on reopen. Best-effort; reschedule via `TERMINATE_EXISTING`. Live-smoked through the API (auto-escalate + resolve-cancels) |
| Incident response (P3.2 / ADR-0046) | `incidentResponseWorkflow` (page→ack-SLA→remind→escalate) auto-started by IncidentsService for severity ≤ threshold; responders = assignee+reporter, escalate to `incident:resolve` holders (`RbacService.usersWithPermission` reverse-lookup) + `incident.escalated` event. `NotificationsService.notifyUsers` seam, kinds `incident.response`/`incident.escalated`. Live-smoked (page+reminder+escalate; ack self-stops) |
| Remaining | approvals/automations, separate `apps/worker` + scaling, prod Temporal (HA/mTLS), post-mortem generation, war-room/external paging, visual builder (P3.8) |
| Blocks | §3.10, §3.23, §3.27 |
| Complexity | substrate M + lifecycle wiring S (done); XL for the visual builder + library |

### Observability plane (OTEL/Prom/Loki/Tempo/Grafana)

| | |
|---|---|
| Status | IN PROGRESS — logs ✅ (P0.3/ADR-0010), traces ✅ emit (P0.6/ADR-0013), metrics ✅ (P0.7/ADR-0014); trace collector + alerting + log aggregation pending |
| Logs | Pino JSON + `request_id` + `trace_id` correlation; Loki shipping → P1.7 |
| Traces | OTEL `NodeSDK` emits HTTP/DB(`db.tx`)/S3/Redis spans; `X-Trace-Id` header; W3C propagation; trace_id on audit rows. Files: `apps/api/src/tracing.ts`, `request-context.middleware.ts`, `tenant-database.service.ts`. Exporter gated on `OTEL_EXPORTER_OTLP_ENDPOINT`; Tempo collector → P1.8 |
| Metrics | ✅ `prom-client` `/metrics` (P0.7 / ADR-0014): HTTP RED histogram (matched-route label), DB saturation (`cmc_db_transactions_*`, `cmc_db_pool_max`), Node defaults. Prometheus + Grafana in `infra/observability-compose.yml` (`pnpm obs:up`); dashboard `cmc-api-red.json`. Files: `apps/api/src/modules/metrics/*`. Business metrics + alerting pending |
| Health probes | ✅ liveness `/health` + readiness `/health/ready` (200/503, parallel timeout-bounded PG/Redis/MinIO probes) + `/health/deep` (authed, per-dep timings) (P0.8 / ADR-0015). Files: `apps/api/src/modules/health/*`. startup + synthetic monitor pending |
| Alerting | none → P1.8 (Alertmanager) |
| Blocks | running the system in any non-dev environment safely |
| Complexity | M to instrument + stack-up; L to operate well |

### Notification plane (in-platform + email + webhook + web push)

| | |
|---|---|
| Status | NOT STARTED |
| Blocks | §3.13, §3.27 (escalation), §3.10 (approvals) |
| Complexity | M for in-platform + email; L for the rest |

### Secrets plane (Vault)

| | |
|---|---|
| Status | ✅ **PRODUCTION-READY (P2.14 + P4.7a/b · ADR-0044 + ADR-0065)** — 2026-06-03: AppRole + KV v2 auth + dynamic DB credentials (lease + renew) |
| Files | `apps/api/src/config/vault-secrets.ts` (KV loader + `resolveVaultToken`), `vault-db-credentials.ts` (lease/swap/renew), `src/main.ts` (both loaders + lease renewer), `src/config/configuration.ts` (`VAULT_*`), `infra/docker-compose.yml` (`vault` dev + `vault-init`) |
| How | Gated boot loaders (pre-DI, env overlay before validation; Vault > `.env`; off → pure-env no-op). **Auth (P4.7a):** `VAULT_AUTH_METHOD` `token` dev / `approle` prod (`/v1/auth/{mount}/login` `role_id`+`secret_id` → `client_token`). **KV (P2.14):** read `/v1/{mount}/data/{path}` → overlay keys. **Dynamic DB creds (P4.7b):** `VAULT_DB_CREDS_ENABLED` → lease `{mount}/creds/{role}` → **swap into `DATABASE_URL` userinfo** (host/db kept); `main.ts` renews the lease at ~½ TTL. `DATABASE_OWNER_URL` stays static; secrets never logged |
| First secret | **MFA_ENC_KEY** — `SecretBoxService` reads it via `config.get` unchanged |
| Tests | **13 hermetic** — `vault-secrets.e2e-spec.ts` 7 (token + AppRole + KV) + `vault-db-credentials.e2e-spec.ts` 6 (gating, DB-engine read + userinfo swap, AppRole reuse, missing role/URL, lease renew). Live smoke: real Vault dev container (AppRole + DB secrets engine) |
| Gotcha | `ConfigModule.forRoot({ validate })` validates at module-import → `main.ts` imports `AppModule` dynamically after both overlays run |
| Deferred (follow-on) | credential **rotation** (re-fetch + hot-swap pool on expiry); k8s auth method; Vault Agent sidecar; **mTLS/TLS to Postgres+Redis** (Linkerd N/A on single-site); Vault Transit backup-encryption |
| Complexity | done (M+L); rotation/hot-swap + k8s-auth + mTLS remaining |

### Realtime analytics (P4.8)

| | |
|---|---|
| Status | ✅ DONE (P4.8a/b · ADR-0066) — 2026-06-03: ClickHouse-native anomaly detection + proactive alerts |
| How | Pure `detectAnomalies` (rolling mean+stddev → Z-score, `minStddev` floor) over the CH daily incident series (`incident_daily_stats_by_region`, gap-filled via `buildDailyTrend`). `GET /v1/analytics/anomalies` (`incident:read`; degrades to `unavailable` when CH off). Proactive `AnomalyAlertService` (gated + isTest-skipped) scans tenants, dedups per (tenant,day,direction) via Redis `SET NX`, notifies `monitoring:read` holders (`analytics.anomaly` kind). Web dashboard widget (server-seeded + 60s BFF poll) |
| Tests | `analytics-anomalies.e2e-spec.ts` **9** (pure spike/dip/flat/short + faked-CH endpoint + RBAC) + `analytics-anomaly-alert.e2e-spec.ts` **1** (new-anomaly notify + dedup). Live smoke: real ClickHouse query + the interval |
| Files | `apps/api/src/modules/analytics/anomaly-detector.ts`, `anomaly-alert.service.ts`, `dashboard-analytics.service.ts`, `analytics.controller.ts`; `apps/web/src/app/dashboard/anomalies-widget.tsx` |
| Deferred (follow-on) | Flink / true streaming; more signals (audit-rate, case volume, per-region); per-tenant thresholds + admin tuning; ML detection |
| Complexity | done (L) |

### AI / LLM gateway (P5.1)

| | |
|---|---|
| Status | ✅ DONE (P5.1 · ADR-0067) — 2026-06-03: gated OpenAI-compatible LLM gateway + per-tenant rate-limit + metadata audit. First item of Horizon P5 (AI tier) |
| How | Gated `LLM_PROVIDER` seam (Noop / `OpenAiCompatLlmProvider` fetch → `{LLM_BASE_URL}/v1/chat/completions`; `LLM_ENABLED`) — works vs vLLM/Ollama/llama.cpp, no vendor SDK. `LlmService`: Redis per-tenant rate-limit (`cmc:llm:rl:{tenant}` → 429) + audit (`llm.complete`, metadata-only unless `LLM_LOG_PROMPTS`; failure audits durable); 503 disabled / 502 provider error. `POST /v1/llm/complete` (`llm:use`; non-streaming). Config-only, no migration |
| Tests | `apps/api/test/e2e/llm.e2e-spec.ts` **5** (Noop factory; completion + metadata-only audit (raw prompt absent); 403; 400; 429). Live smoke: real vLLM on a GPU host |
| Files | `apps/api/src/modules/llm/` (`llm.provider.ts`, `llm.service.ts`, `llm.controller.ts`, `llm.module.ts`); `packages/contracts/src/llm.ts`; `llm:use` perm; `LLM_*` config |
| Deferred (follow-on) | SSE streaming; token-bucket + per-user limits; ~~embeddings (P5.2)~~ ✅ done; model routing/fallback + prompt-injection guardrails; vLLM compose profile + GPU manifest |
| Complexity | done (L); substrate for P5.4 RAG / P5.5 copilots |

### AI / Vector pipeline (P5.2)

| | |
|---|---|
| Status | ✅ DONE (P5.2 · ADR-0068) — 2026-06-03: embeddings via the LLM gateway + Postgres `jsonb` vector store + gated best-effort indexer. Second AI substrate of Horizon P5 |
| Reframe | Plan named **Qdrant** / "migrate or supplement pgvector". Dev/test Postgres is **PostGIS** → stacking pgvector (or `CREATE EXTENSION vector`) is non-trivial + breaks the suite if absent; Qdrant is a heavy new container. First cut stores vectors **in Postgres as `jsonb`** (no extension, no container), gated. **pgvector ANN / Qdrant = scale follow-on** that swaps in without changing the pipeline |
| How | `LlmProvider.embed(texts, model)` (OpenAI-compatible `/v1/embeddings`; `LLM_EMBED_MODEL` default `bge-m3`) reuses the P5.1 gateway — one AI substrate for chat + embeddings. `document_embeddings` (migration 0041, RLS): `document_id` FK cascade **unique** (one vector/doc, upsert), `model`, `dims`, `embedding` **`jsonb`**. `VectorIndexService` active only when **`VECTOR_ENABLED` AND provider up** (no-op in dev/test/CI). Best-effort on the document lifecycle (`DocumentsService.indexDoc` embed+upsert on finalize; `removeDocument` on delete — never blocks the write path, mirrors OpenSearch P3.6). `reindexAll` backfill; `status` `{active, indexed}`. `GET /v1/vector/status` (`document:read`) + `POST /v1/vector/reindex` (`document:write`) |
| Tests | `apps/api/test/e2e/vector.e2e-spec.ts` **4** (reindex embeds available docs asserting dims/model/the stored vector; idempotent upsert — no dup rows; status; RBAC 403 — faked provider). Live smoke: real OpenAI-compatible `/v1/embeddings` |
| Files | `apps/api/src/modules/vector/` (`vector-index.service.ts`, `vector.controller.ts`, `vector.module.ts`); `apps/api/src/modules/llm/llm.provider.ts` (`embed()`); `packages/db/src/schema/document-embeddings.ts` (+ migration 0041); `packages/contracts/src/vector.ts`; `DocumentsService` index/unindex hook; `VECTOR_ENABLED` + `LLM_EMBED_MODEL` config |
| Deferred (follow-on) | pgvector ANN index / Qdrant at scale; async (NATS) embedding worker; embed incidents + cases; chunk long docs; full-content extraction (P5.6); ~~semantic search over the vectors (P5.3)~~ ✅ done |
| Complexity | done (L); substrate for P5.3 semantic search / P5.4 RAG |

### AI / Semantic search (P5.3)

| | |
|---|---|
| Status | ✅ DONE (P5.3 · ADR-0069) — 2026-06-03: brute-force vector kNN fused into the federated `/v1/search` by RRF, permission-aware. Third AI item of Horizon P5 |
| Decisions | AskUserQuestion: **brute-force cosine over jsonb** (no pgvector — ANN = scale follow-on) · **RRF fusion reusing P3.7** · **fold into `/v1/search`** (one surface). Vectors are **documents-only** (P5.2 deferred incidents/cases), so the lane augments the documents portion |
| How | Pure `cosineSimilarity(a,b)` (`vector/cosine.ts`; 0 for non-comparable dims/zero-norm) + `VectorIndexService.similar(query,cap)` (gated; embeds the query via the LLM gateway, RLS-reads tenant vectors, scores equal-dim rows, drops non-positive, top-`cap` `{id,score}[]` — symmetric with the OpenSearch lane). `SearchService` resolves the lane before the tx and hydrates via the **same `hydrateDocHits`** as keyword → **folder-access + RLS + `ready`-only + `deleted_at` filters apply identically** (permission-aware). `fuse()` **sums RRF per `(type,id)`** → a doc in both lanes is **deduped to one boosted `hybrid` hit** (`SearchSource` += `vector`,`hybrid`); disjoint lanes unchanged (P3.7 preserved). **Also fixed a P5.2 bug:** `reindexAll` filtered `status="available"` but docs finalize to `ready` (live indexer + hydrate use `ready`; the e2e masked it) → would embed nothing / drop hits |
| Tests | `apps/api/test/e2e/search-semantic.e2e-spec.ts` **7** (pure cosine ×3; vector-only doc → `vector`; both-lane doc deduped → `hybrid` w/ boosted score; soft-deleted nearest-neighbour dropped by hydrate; no `document:read` → empty). Faked provider; OpenSearch off → keyword lane = Postgres FTS. Live smoke: real `/v1/embeddings` |
| Files | `apps/api/src/modules/vector/cosine.ts` (new), `vector-index.service.ts` (`similar()` + status fix); `apps/api/src/modules/search/search.service.ts` (vector lane + `hydrateDocHits` + per-item RRF), `search.module.ts` (+`VectorModule`); `packages/contracts/src/search.ts` (`vector`+`hybrid`) |
| Deferred (follow-on) | pgvector ANN / Qdrant at scale; query-embedding cache; embed + search incidents+cases; chunk long docs (P5.6); web `hybrid`/`vector` source badge (P3.7b) |
| Complexity | done (L); substrate for P5.4 RAG |

### AI / RAG framework (P5.4)

| | |
|---|---|
| Status | ✅ DONE (P5.4 · ADR-0070) — 2026-06-03: strictly-grounded, cited, audited Q&A composed from the existing AI seams. Fourth AI item of Horizon P5 |
| Decisions | AskUserQuestion: retrieval **reuses `/v1/search`** (P5.3 hybrid, permission-aware) · **strict grounding + inline `[n]` citations** · new **`POST /v1/rag/ask`** · audit = **metadata + cited source ids** (no raw text). **Composition seam — no new model/store/migration** |
| How | `RagService.ask`: 503 if provider inactive → retrieve via `SearchService.search` (hits already RBAC+folder filtered, so RAG grounds only in what the caller may read) → **no sources = honest no-answer, `grounded:false`, NO LLM call** (still audited) → numbered context from `title`+`snippet` (docs = name+description until P5.6) bounded by `RAG_CONTEXT_CHAR_BUDGET` → generate via `LlmService.complete` (inherits rate-limit + 502 + `llm.complete` audit) with a strict-grounding prompt @ temp 0 → parse `[n]` → `citations[]` ({type,id,title}) → **`rag.ask` audit** = metadata + `citedSources` provenance (raw Q/A only under `LLM_LOG_PROMPTS`; failure durable) |
| Tests | `apps/api/test/e2e/rag.e2e-spec.ts` **6** (grounded + `[n]`→id citation; no-answer with **no LLM call**; metadata-only audit — cited ids present, raw question absent; 403 без llm:use; 400 empty; 503 disabled). Faked provider; real permission-aware hybrid retrieval. Live smoke: real generation |
| Files | `apps/api/src/modules/rag/` (`rag.service.ts`, `rag.controller.ts`, `rag.module.ts`); `packages/contracts/src/rag.ts`; `RAG_TOP_K`+`RAG_CONTEXT_CHAR_BUDGET` config; `app.module.ts` |
| Deferred (follow-on) | SSE streaming; RAG-specific rate limit; full-content context + chunking (P5.6); ground in incidents/cases bodies; web ask-UI with rendered citations; faithfulness/citation-coverage eval |
| Complexity | done (L); substrate for P5.5 copilots |

### AI / Per-module copilots (P5.5)

| | |
|---|---|
| Status | ✅ DONE (P5.5 · ADR-0071) — 2026-06-03: read-only, module-scoped, record-anchored copilot over a unified endpoint. Framework + **Incidents** copilot; GIS/Docs/Workflow follow-on. Fifth AI item of Horizon P5 |
| Decisions | AskUserQuestion: **read-only advisory** (actions = follow-on) · **framework + Incidents first** · **module-scoped RAG + `resourceId` anchor** · **unified `/v1/copilot/ask`**. Composition seam — **no new model/store/migration/permission** |
| How | `CopilotService` per-module registry `{readPermission, domainTypes, systemPrompt, loadAnchor}` (incidents → `incident:read`, `["incident"]`, EOC persona, anchor via `IncidentsService.getDetail`). 503 if provider off → resolve perms (**llm:use w/o module read-perm → honest no-answer, no leak**) → optional `resourceId` anchor (pinned, only if accessible) → module-scoped `SearchService` retrieval filtered to `domainTypes` → merge+dedupe → shared `assembleContext` → no sources ⇒ no-answer, **no LLM call** → else `LlmService.complete` (rate-limit/502/`llm.complete` audit) w/ strict-grounding prompt @ temp 0 → `resolveCitations` → **`copilot.ask` audit** (module + cited-id provenance; raw Q/A only under `LLM_LOG_PROMPTS`). **DRY:** `assembleContext`+`resolveCitations` extracted to `rag/grounding.ts`, shared with RAG |
| Tests | `apps/api/test/e2e/copilot.e2e-spec.ts` **7** (module grounding + `[n]`→id; `resourceId` anchor w/o keyword match; llm:use без incident:read → no-answer + no LLM call; metadata-only `copilot.ask` audit; 403; 400 empty/unknown module; 503 disabled). Faked provider; real permission-aware retrieval. Suite 67/471 — all AI suites green; full-green captured at P5.4 (66/464); the P5.5 serial run was 65/67 (2 unrelated suites — `rate-limit`, `documents-search-index` — timed out at 153s/900s on local host exhaustion, not regressions). Live smoke: real generation |
| Files | `apps/api/src/modules/copilot/` (`copilot.service.ts`, `copilot.controller.ts`, `copilot.module.ts`); `apps/api/src/modules/rag/grounding.ts` (new, shared; `RagService` refactored to use it); `packages/contracts/src/copilot.ts`; `app.module.ts` |
| Deferred (follow-on) | GIS/Docs/Workflow copilots (registry entries + anchor loaders); action-capable (tool-calling + per-tool RBAC + confirm); web copilot panels per module; SSE streaming; copilot rate limit |
| Complexity | done (L) |

### AI / Document intelligence (P5.6)

| | |
|---|---|
| Status | ✅ DONE (P5.6 · ADR-0072) — 2026-06-03: gated text extraction (PDF text-layer + Tesseract OCR) → OpenSearch `content` + P5.2 re-embed. Sixth AI item of Horizon P5 |
| Decisions | For sovereign КЧС single-site/no-GPU: **Tesseract + PDF text-layer** (CPU, live boundary) · **text only** (classification/fields follow-on) · **async BullMQ** (like preview P2.13) · **OpenSearch `content` + re-embed**. Mirrors preview pipeline; split a (substrate) / b (async+re-index) |
| How | `document_text` sidecar (migration 0042, RLS; `document_id` unique, `content`/`char_count`/`status`/`extracted_at`) — sidecar so big text doesn't bloat list/get. Gated `TEXT_EXTRACTOR` (Noop / Real live-boundary `pdf-parse`+`tesseract.js` via non-literal dyn-import → out of build/test deps). `DocumentExtractionService.extract` (runForTenant → loadReadyDoc → `getObjectBytes` → extract → cap → upsert; 503/404) + `status`. `POST /v1/documents/:id/extract` (`document:write`) + `GET :id/text` (`document:read`). **Async:** gated `EXTRACT_QUEUE`+`ExtractWorker`; `DocumentsService` auto-enqueues on finalize. **Re-index:** `extract()` best-effort → OpenSearch `indexDocument({…,content})` + vector re-embed with content (`IndexedDocument`/`DocLike` += optional `content`) |
| Tests | `document-extraction` **7** (extract/store/idempotent/empty/not-extracted/404/RBAC/503) + `document-extract-pipeline` **2** (re-index→OpenSearch content + `document_embeddings` row; auto-enqueue on finalize). Blast radius **15 suites / 81 tests** green serially (documents/search/vector/rag/copilot/previews/extraction). Live smoke: real Tesseract + BullMQ worker (`DOC_EXTRACT_ENABLED`, libs on host) |
| Files | `packages/db/src/schema/document-text.ts` (+ mig 0042); `packages/contracts/src/document-text.ts`; `apps/api/src/modules/documents/` (`text-extractor{,.impl}.ts`, `extract.queue{,-impl}.ts`, `extract.worker.ts`, `document-extraction.{service,controller}.ts`, `documents.{service,module}.ts`); `search-index{,.impl}.ts` + `vector-index.service.ts` (`content`); `DOC_EXTRACT_*` config |
| Deferred (follow-on) | classification + structured field/entity extraction; chunking long docs (>8k embed cap); per-page OCR + lang auto-detect + confidence; web extracted-text view + reindex-all-with-content |
| Complexity | done (L); unlocks full-content for FTS/semantic/RAG/copilots |

### Sovereign / air-gap install (P5.8)

| | |
|---|---|
| Status | ✅ DONE (P5.8 · ADR-0073) — 2026-06-03: offline `docker save` bundle + SHA-256 manifest + on-site install/verify scripts. (P5.7 multi-region active-active ⛔ N/A — single-site) |
| Decisions | **images tar + compose + scripts** (not OCI registry) · **full stack** · **SHA-256 manifest + verify** (no signing). Build on a connected host, transfer one tamper-evident tarball, install fully offline |
| How | `infra/airgap/build-bundle.sh` (build from-source images → enumerate all images across deploy+data+observability compose via `config --images` → `docker save\|gzip` → stage compose/.env/scripts → `MANIFEST.sha256` → tarball). `verify-bundle.sh` (`sha256sum -c`). `install.sh` (verify→`docker load`→.env→data plane→Postgres health→migrate→`up -d`→`/health` smoke). Gated AI flags stay off unless on-host toolchain present |
| Tests | `bash -n` clean ×3 + image-enumeration dry-run vs live compose. Infra/ops (like P3.13/P0.5) — no jest; real offline build→install drill = manual. No app code touched |
| Files | `infra/airgap/{build-bundle,verify-bundle,install}.sh`; `docs/runbooks/sovereign-airgap-install.md` |
| Deferred (follow-on) | cosign/GPG signing (provenance); slim core+profiles build; delta upgrade bundles |
| Complexity | done (M) |

### Single-site DR readiness (P5.DR — reframed from P5.7)

| | |
|---|---|
| Status | ✅ DONE (P5.DR · ADR-0074) — 2026-06-03: backup-freshness endpoint + RPO/RTO + restore-drill runbook. The single-site analogue of multi-region resilience (P5.7 active-active ⛔ N/A) |
| How | `StorageService.listObjects` (`ListObjectsV2`) → `BackupStatusService.status()` (newest `postgres/*.dump` by `lastModified`, age vs RPO → `fresh`). `GET /v1/ops/backups/status` (`monitoring:read`). Config `BACKUP_S3_BUCKET`/`BACKUP_RPO_HOURS` (36). Runbook `docs/runbooks/disaster-recovery.md` (RPO/RTO, freshness check, `pnpm db:restore` drill, air-gap rebuild P5.8, warm-standby P3.13) |
| Tests | `backup-status` **4** (fresh/stale/empty/RBAC). Faked StorageService listing. Live boundary: real MinIO + restore drill |
| Files | `apps/api/src/modules/backups/*`; `StorageService.listObjects`; `packages/contracts/src/backup.ts`; `BACKUP_*` config; `docs/runbooks/disaster-recovery.md` |
| Deferred (follow-on) | Prometheus `cmc_backup_age_hours` gauge + Alertmanager rule; scheduled freshness notification; periodic **test-restore** (restorability); WAL/PITR |
| Complexity | done (S) |

### Mobile / PWA companion (P4.4)

| | |
|---|---|
| Status | ✅ DONE (P4.4 · ADR-0075) — 2026-06-03: installable PWA on the existing Next.js + offline incident capture. (Was DEFERRED; PWA chosen over React Native for single-site/air-gap/sovereign) |
| How | `app/manifest.ts` (→ `/manifest.webmanifest`, installable), `public/sw.js` (conservative: precache offline shell, nav network-first→`/offline`, API/RSC untouched), `public/icon.svg` + `viewport.themeColor`, `app/offline`, `components/pwa-register.tsx` (SW register + online/offline & queue badge + **drain on reconnect**). Offline capture: `lib/offline-incidents.ts` (IndexedDB queue); create-incident form queues when offline / on action throw; replayed via the same `createIncidentAction` (BFF+RLS+audit) on reconnect |
| Tests | Web **tsc ✓ / lint ✓ / `next build` ✓** (29 routes incl. generated manifest + /offline). `output:standalone` ⇒ `next start` smoke N/A; auth/middleware untouched (307/401 unchanged). Live boundary: install + SW offline nav + IndexedDB→sync = manual browser smoke |
| Files | `apps/web/{public/sw.js,public/icon.svg,src/app/manifest.ts,src/app/offline/page.tsx,src/components/pwa-register.tsx,src/lib/offline-incidents.ts,src/app/layout.tsx,src/app/incidents/create-incident-form.tsx}` |
| Deferred (follow-on) | offline for more modules + read offline-first cache; Web Push (SW in place) + background-sync; encrypt queued drafts; PNG icon set; install-prompt UX |
| Complexity | done (M) |

### Backups plane (Postgres)

| | |
|---|---|
| Status | DONE (logical nightly dump; PITR deferred) — 2026-05-25, P0.5, ADR-0012 |
| Files | `infra/backup/{Dockerfile, entrypoint.sh, backup.sh, restore.sh}`, `infra/docker-compose.yml` (postgres-backup service) |
| Tooling | alpine + postgresql16-client + `mc` + busybox crond |
| Cadence | `BACKUP_SCHEDULE_CRON` (default `0 3 * * *` UTC), retention `BACKUP_RETENTION_DAYS` (default 7d) |
| Storage | MinIO bucket `cmc-backups`, key `postgres/YYYY/MM/cmc-<ISO-Z>.dump` |
| Manual | `pnpm db:backup` / `pnpm db:restore <key\|latest>` (TTY confirmation + `CONFIRM_RESTORE=yes` for scripted callers) |
| Drill | rehearsed end-to-end: seed → backup → wipe → restore → e2e auth suite green |
| Observability today | `docker compose logs postgres-backup` |
| Deferred to | P0.7 (Prometheus metric) · P1.8 (Alertmanager "no fresh backup in 36 h") · Vault-encrypted dump bytes (Vault adoption began P2.14 / ADR-0044; backup-encryption not yet wired) · P3 (WAL streaming / PITR) |

### Edge / TLS plane (Caddy)

| | |
|---|---|
| Status | DONE (edge + app images; full stack live-validated) — 2026-05-25, P0.9 (ADR-0016) + P0.10 (ADR-0017) |
| Files | `infra/caddy/Caddyfile`, `infra/deploy-compose.yml`, `infra/.env.production.example` |
| TLS | automatic — Let's Encrypt in prod, internal CA for `*.localhost` dev |
| Routing | subdomain: `{$APP_HOST}`→web, `{$API_HOST}`→API. Path-based routing now **unblocked** — `/v1` (P1.9 / ADR-0027) removed the web/API path collision (`/documents` vs `/v1/documents`) — but subdomain routing is retained (no edge rework in P1.9) |
| Edge policy | HSTS + nosniff + X-Frame DENY + Referrer-Policy + `-Server` + gzip; `/metrics` + `/health/deep` → 404 (ADR-0014/0015 follow-ons) |
| Upstreams | ✅ `api:3001` / `web:3000` compose service names (flipped at P0.10) |
| App images | ✅ `api` + `web` distroless non-root images built + run in the overlay (P0.10 / ADR-0017); `api` joins external `cmc-net` |
| Manual | `pnpm infra:up` (core) then `pnpm deploy:up/down/logs/ps/validate` |
| Validated | full stack: certs issued; HTTPS/2 → API 200; /health/ready 200 all-deps-up (minio via service name); /metrics 404; web 200; all 3 containers healthy |
| Deferred to | image scanning/SBOM (TD-029) · CI build-push · edge WAF/rate-limit · P4 (mTLS mesh) |

### High-availability plane (P3.13 / ADR-0058)

| | |
|---|---|
| Status | DONE — pragmatic HA introduced (2026-06-03) |
| Stateless | `api` is horizontally scalable — `container_name` dropped, no host port; `docker compose -f infra/deploy-compose.yml up -d --scale api=N`; Caddy API site → **dynamic DNS upstreams** (`dynamic a` + `lb_policy round_robin`, refresh 5s) load-balances replicas live |
| Pooling | **PgBouncer** (transaction mode) fronts Postgres; runtime `DATABASE_URL`→`pgbouncer:6432`. Safe: tx-scoped GUCs (`set_config(...,is_local:=true)`) + driver `prepare:false`; owner/migration path bypasses the pooler |
| N-instance correctness | relay / audit sealer / export / projection already `pg_advisory_xact_lock`-guarded; **closed gap** — retention sweep now `pg_try_advisory_xact_lock(40_211_500)`. Verified: Redis-shared sessions/rate-limit/RBAC, per-instance NATS fan-out (realtime spans replicas), shared BullMQ queue |
| Stateful sample | `infra/ha/docker-compose.ha.yml` — Postgres primary+streaming-standby + PgBouncer + Redis master/replica + 3-node Sentinel (quorum 2) + `redis-sentinel.conf` + README (documented target, not default-up; bitnami images for legibility — prod = PostGIS-capable HA Postgres) |
| Files | `infra/deploy-compose.yml`, `infra/caddy/Caddyfile`, `infra/ha/`, `apps/api/src/modules/documents/retention.service.ts`, `docs/runbooks/ha.md` |
| Validated | `tsc` + retention e2e 6/6 + full suite 53/386 (0 regressions); `docker compose config` exit 0 (deploy + ha); `caddy validate` → valid |
| Deferred | app read-replica routing (`DATABASE_REPLICA_URL`), Redis Sentinel client, automated failover/fencing, multi-region (P4.6) |

### Compliance readiness — SOC 2 (P3.14)

| | |
|---|---|
| Status | DONE — control map + gap analysis + evidence register (2026-06-03); docs, no code |
| Deliverables | `docs/compliance/soc2-control-mapping.md` (TSC CC1–CC9 + Availability + Confidentiality → status → evidence) + `docs/compliance/evidence-register.md` (system-produced evidence w/ cadence/owner + manual gaps + Type I→II path) |
| Framing | Engineering self-assessment of *technical* controls, not a SOC 2 report; organizational controls flagged 🏛 (management) |
| Strengths | anchored tamper-evident audit trail (ADR-0029) + SIEM export (ADR-0030), DB-enforced tenant RLS, least-privilege RBAC + scoped API keys, MFA, encrypted-at-rest secrets, backups + restore drill, full-stack observability |
| Technical gaps | at-rest SSE enforcement + KMS record, mTLS/prod-Vault, CI security scanning (CodeQL/Trivy/SBOM/ZAP), segregated staging + release/rollback gate, running SIEM, DR test, automated access reviews, edge WAF |
| Org gaps (🏛) | security policy set, risk register, vendor/sub-processor inventory, HR security (onboarding/offboarding/training), defined audit period + control owners |

---

### Web localization plane (i18n — RU/TG · ADR-0076)

| | |
|---|---|
| Status | ✅ **DONE (MVP) — full operator UI Russian-by-default + Tajik, switchable** (2026-06-04). UI was English-only; every page/component now localized via next-intl |
| How | `next-intl` **no-routing** setup — active locale in the `NEXT_LOCALE` cookie (no `/ru` URL prefix), `defaultLocale = "ru"`, locales `["ru","tg"]`. `getRequestConfig` loads `messages/{locale}.json` (works anonymous → login is RU out of the box). Root layout: `<html lang={getLocale()}>` + `<NextIntlClientProvider>`. Topbar `LanguageSwitcher` writes the cookie via a server action + `router.refresh()` |
| Done (slice 1) | Foundation (`src/i18n/{config,request,locale-actions}.ts`, `messages/{ru,tg}.json`, plugin in `next.config.ts`) + **app shell** (sidebar nav + topbar) + **login** (page + form + sign-out) + switcher |
| Done (slice 2) | **dashboard** (KPIs, hero, trend, anomalies widget, region/type/priority cards) + **incidents** (list, filters, create form, detail, actions/edit, video widget) + **offline** page + **localized status badges** (`incidents.status.*`; StatusBadge → client `useTranslations`) + page breadcrumbs |
| Done (slice 3) | **search** (page + box + source/type labels + error keys) + **documents** (page, upload form phases, row actions) + **map** (page + MapView layer panel/feature inspector) |
| Done (slice 4) | **admin/\*** — overview + users (+ create/row) + roles (+ create/card) + tenant (+ identity/branding forms) + regions (+ manager) + api-keys (+ manager) + api-docs (+ swagger client). New `admin` namespace (190 keys); `common.roleAdmin` added |
| Done (slice 5) | **chat, wiki, video, media, monitoring, imports, workflows, notifications** (pages + workspaces/editors/managers) + `notification-bell` + `pwa-register` offline badge. 9 new namespaces. (`room-stage`/`media-player` have no UI strings — LiveKit/HLS native.) **ru↔tg key parity verified 721/721** |
| UX consolidation (2026-06-05) | Merged the two duplicate **Operations** nav entries — the lifted **"Command Center"** and **"Realtime Monitoring"**, which both pointed at `/monitoring` — into a single item **«Мониторинг в реальном времени»** / TG **«Мониторинги фаврӣ»**. Removed the `command` NAV entry + `Radio` icon from `sidebar.tsx`; monitoring page now `active="monitor"`; renamed the page meta-title/breadcrumb/H1 keys (`monitoring.metaTitle`/`crumbCommandCenter`/`commandCenter`) so the page header matches the nav label; deleted the now-dead `nav.items.command` key from both catalogs. **ru↔tg leaf-key parity 693/693.** Validated: tsc ✓ / lint ✓ / `next build` ✓; authed live `/monitoring` → 200, exactly one nav link, **zero** "Командный центр" in the rendered HTML, RU title «Мониторинг в реальном времени». Files: `app/monitoring/page.tsx`, `components/cmc/sidebar.tsx`, `messages/{ru,tg}.json` |
| Date/time localization (2026-06-05) | Replaced locale-naive `new Date(x).toLocale*()` (which rendered in the server's en-US regardless of UI language) with the next-intl formatter so timestamps follow `NEXT_LOCALE`. New `lib/datetime.ts` (DATETIME/DATE/TIME presets) + `components/cmc/formatted-date.tsx` (`<FormattedDate>` client island for client components); the two server pages use `getFormatter()`. 10 sites / 8 files (chat, documents, imports, monitoring wall + replay, video, wiki page + workspace). Validated: tsc ✓ / lint ✓; authed live `/documents` — RU «4 июн. 2026 г., 16:28» vs TG «04 Июн 2026, 16:28» (same row, locale-correct, was English before). |
| AI Assistant page (2026-06-05) | Lit up the previously-disabled **«AI Assistant»** nav item with a real page — `/ai` (route + `ai-console.tsx` client + `actions.ts` BFF). Reuses the existing, e2e-tested **RAG** backend (`POST /v1/rag/ask`, P5.4 / ADR-0070): a question box → grounded answer with `[n]` citations (linked to incident/document) + grounded/model badges. Gated on `llm:use` (page-level + API `@Authorize`); the nav item is now enabled+gated and `/ai` added to middleware. Degrades gracefully when the LLM gateway is off (503 → localized «не настроен»; 429/502/403 also mapped). New `ai` i18n namespace (22 keys, RU/TG; parity 715/715). Validated: tsc ✓ / lint ✓ / `next build` ✓ (`/ai` route, 3.57 kB); authed live `/ai` → 200 with the console rendered in RU + TG, nav `href="/ai"`; `POST /v1/rag/ask` (LLM off) → **503 "LLM gateway is disabled"** (the `errDisabled` path). Files: `app/ai/{page,ai-console,actions}.tsx`, `components/cmc/sidebar.tsx`, `middleware.ts`, `messages/{ru,tg}.json`. |
| Audit log viewer (2026-06-06) | Lit up the disabled **«Audit»** nav item — a read-only, RLS-scoped audit-trail viewer. **New backend** `GET /v1/audit/log` `@Authorize("audit:read")` — the **first endpoint to use `audit:read`** (held by the `auditor` role; distinct from the `tenant:manage` chain-management ops). `AuditService.listLog` queries `audit_log` newest-first by `seq` with keyset pagination (`before`) + action/resourceType/outcome filters; returns a safe subset (no raw chain hashes, exposes a `sealed` flag). Contracts `AuditLog{Entry,Query,ListResponse}` + `AUDIT_OUTCOMES` in `audit.ts`. **Web** `/audit` page (table: time via `<FormattedDate>`, action, resource, actor, outcome chip, sealed ✓) + `audit-filters.tsx` (URL-driven) + "older" cursor pager; gated `audit:read`; `/audit` in middleware; new `audit` i18n namespace (32 keys, RU/TG; parity 747/747). Validated: contracts build ✓, API tsc ✓, web tsc/lint/`next build` ✓ (`/audit` 883 B); **e2e 5/5** (auditor reads, operator 403, filter, pagination no-overlap, RLS tenant-isolation); authed live `/audit` → 200 in RU + TG with real `user.login` rows, nav `href="/audit"`. Files: `modules/audit/{audit.service,audit.controller}.ts`, `contracts/audit.ts`, `test/e2e/audit-log.e2e-spec.ts`, `app/audit/{page,audit-filters}.tsx`, `sidebar.tsx`, `middleware.ts`, `messages/{ru,tg}.json`. |
| Analytics page + nav cleanup (2026-06-06) | Lit up the disabled **«Analytics»** nav item with `/analytics` (server page, **frontend-only** — reuses the P2.6 + P4.8 backends): a **30-day incident trend** (`GET /analytics/dashboard?days=30`, reuses `<TrendChart>`) + a full **anomaly table** (`GET /analytics/anomalies?days=30` — Z-score spike/dip with count, expected μ±σ, z, direction chip). Gated `incident:read`; `/analytics` in middleware; degrades to «недоступна» when ClickHouse is off. **Removed the redundant «Tenants» nav item** (single-site; tenant admin lives under Administration → `/admin/tenant`) incl. its unused `Users` icon + `nav.items.tenant` key; refactored the sidebar `disabled` ternary into a permission-map for maintainability. New `analytics` i18n namespace (24 keys, RU/TG; parity 770/770). Validated: web tsc/lint/`next build` ✓ (`/analytics` 208 B); authed live `/analytics` → 200 RU+TG, nav `href="/analytics"`, **zero** "Tenants" in render, graceful CH-off state. **This closes the dead-nav-item cleanup** (monitoring consolidated; AI/Audit/Analytics lit up; Tenants removed). Files: `app/analytics/page.tsx`, `components/cmc/sidebar.tsx`, `middleware.ts`, `messages/{ru,tg}.json`. |
| Analytics pipeline enabled in dev (2026-06-06) | Flipped on the event-driven analytics plane so `/analytics` (+ the dashboard widgets) show **real** data instead of «недоступна». Set `NATS_ENABLED=true` + `CLICKHOUSE_ENABLED=true` in `apps/api/.env` + restarted the API → NATS connected, `IncidentProjectionSubscriber` subscribed (`DeliverPolicy.All`), the relay drained the incident outbox → CMC_EVENTS → projected to `cmc.incident_events`/daily-stats MV. Verified: `/v1/analytics/dashboard` → `source:clickhouse` with a real trend (6 incidents on 2026-06-02) and `/v1/analytics/anomalies` flags a **spike** (z=6 ≥ 3); live `/analytics` renders the trend chart + the localized anomaly row («2 июн. 2026 · Всплеск»). Also **fixed the `cmc-clickhouse` healthcheck** (`localhost`→`127.0.0.1`; alpine `localhost` resolved to IPv6 ::1 → "connection refused" → container perpetually *unhealthy*) — now healthy; data persisted across recreate. Note: enabling `NATS_ENABLED` activates the **whole** event plane (relay + projection + notifications + workflow-trigger + realtime fan-out consumers). Files: `apps/api/.env`, `infra/docker-compose.yml`. |
| Map basemap → same-origin proxy (2026-06-06) | Fixed "карты нет опять": after the 2026-06-05 CARTO basemap, users still saw only the flat light-grey backdrop — the **browser** couldn't reach `cartocdn.com` directly (restrictive/gov network or blocker), even though the server could. **Replaced the direct CARTO tile URLs with a same-origin BFF proxy** `GET /api/map/tiles/[variant]/[z]/[x]/[y]` (mirrors the GIS tile proxy): the server fetches the upstream CARTO tile + streams it back with a 7-day immutable cache. The browser now only needs to reach the app itself — not any external CDN. SSRF-safe (variant allow-list + numeric z/x/y → can only hit a CARTO basemap tile). `map-view.tsx` `cartoTiles()` now returns `${origin}/api/map/tiles/${variant}/{z}/{x}/{y}`; theme light/dark swap unchanged; `NEXT_PUBLIC_MAP_STYLE_URL`/`NEXT_PUBLIC_MAP_RASTER_URL` overrides still bypass the proxy. Validated: tsc/lint/`next build` ✓ (route 159 B); live `/api/map/tiles/{light_all,dark_all}/6/44/24` → **200 image/png (18 KB)**, bad variant → **400**. (Diagnosis confirmed with the user: light-grey box = backdrop only = tiles not loading in the browser; WebGL fine since the backdrop rendered.) Files: `app/api/map/tiles/[variant]/[z]/[x]/[y]/route.ts` (new), `components/cmc/map-view.tsx`. |
| Map container height collapse — THE root cause (2026-06-06) | The proxy above wasn't enough: users still saw a flat light-grey box. **Real bug found via live browser debugging** (Preview MCP — login, navigate `/map`, inspect DOM/console/WebGL): the map container `<div className="absolute inset-0">` was computing **`height: 0`** — because `maplibre-gl.css` sets `.maplibregl-map { position: relative }`, which **overrides Tailwind's `absolute`**, so `inset-0` no longer stretches the div → 0 height → MapLibre has a 0-size viewport → **never requests/paints tiles** (looked like "no map"). Fix: container is now **`h-full w-full`** (height:100% of the definite-height parent — position-agnostic, immune to maplibre's CSS), plus a **`ResizeObserver` → `map.resize()`** (and a resize on `load`) for late-settling/flex layouts. Verified **in a real browser**: container 0→**796px**, WebGL healthy (Apple M4 Pro Metal), and the **full CARTO basemap of Tajikistan renders** (Dushanbe, Khatlon/Sughd/GBAO provinces, borders, water, labels) + zoom controls + attribution. (Note: MapLibre fetches tiles in a Web Worker, so they don't appear in the main-thread `performance` resource list — an earlier "0 requests" reading was a false negative.) tsc/lint ✓. Files: `components/cmc/map-view.tsx`. |
| Tests | tsc ✓ + lint ✓ + `next build` ✓ (33 routes); authed live curl RU + `NEXT_LOCALE=tg` TG: `/dashboard`, `/incidents`, `/incidents/[id]`, `/search`, `/documents`, `/map`; `/offline` RU+TG (zero real leftover EN) |
| Files | `apps/web/src/i18n/*`, `messages/{ru,tg}.json`, `components/cmc/{language-switcher,sidebar,topbar,incident-badges}.tsx`, `components/{sign-out-button,login-form}.tsx`, `next.config.ts`, `app/layout.tsx`, `app/login/page.tsx`, `app/dashboard/{page,anomalies-widget}.tsx`, `app/incidents/{page,incident-filters,create-incident-form}.tsx` + `app/incidents/[id]/{page,incident-actions,incident-video}.tsx`, `app/offline/page.tsx` |
| Remaining (follow-on, optional) | next-intl **number** + relative-time formatting (dates/times done 2026-06-05); persist chosen locale to the user profile (server-side) in addition to the cookie; seed `branding.localeDefault = "ru"`; TMS workflow if a 3rd language is added. **All visible operator UI is translated.** |
| Complexity | foundation done (S); incremental string migration M (broad but mechanical) |

---

### Web theming plane (light default + dark · ADR-0077)

| | |
|---|---|
| Status | ✅ **DONE (2026-06-04)** — was dark-only; now **light by default + dark toggle** |
| How | CSS-var token split in `globals.css`: `:root` = light palette (default), `.dark` = original dark palette; `color-scheme` per theme; Tailwind `darkMode: "class"`. Theme in a `theme` cookie (default light) read server-side in the root layout → `dark` class on `<html>` before paint (no flash). Topbar `ThemeToggle` (sun/moon) flips the class instantly + writes the cookie |
| Tests | tsc ✓ + lint ✓ + `next build` ✓; live curl: default → no `.dark` (light), `theme=dark` → `.dark`; toggle present on authed pages (`aria-label="Тема"`) |
| Files | `src/app/globals.css`, `src/lib/theme.ts`, `src/components/cmc/theme-toggle.tsx`, `src/app/layout.tsx`, `src/components/cmc/topbar.tsx`, `messages/{ru,tg}.json` (`topbar.theme`) |
| Theme-aware extras (2026-06-04) | MapLibre basemap follows theme + re-tints live on toggle (`MutationObserver`) — backdrop on 2026-06-04, upgraded to a real **CARTO light/dark raster basemap on 2026-06-05** (see ADR-0039 addendum); PWA offline badge → CSS vars; PWA manifest colors → light `#f0f3f7` |
| Profiles + system (ADR-0078) | ✅ **2026-06-04** — theme **+ locale persisted to the user profile** (`GET/PATCH /v1/me/preferences`; `users.ui_theme`/`ui_locale`, mig 0043; e2e 8/8); seeded into cookies on login; **`system` mode** (prefers-color-scheme, pre-paint script, live OS tracking). 3-state toggle (light/dark/system) |
| Deferred (follow-on) | per-theme `viewport.themeColor` (`generateViewport`); live cross-device sync (now login-seeded); `<head>` pre-paint script for guaranteed zero-flash `system` |
| Complexity | done (S + S) |

---

## Summary table

| Module | Status | Compl. % | Complexity to finish |
|---|---|---|---|
| 3.1 IAM | PARTIAL | 40 % | L |
| 3.2 Multi-Tenancy | DONE (shared-schema mode) | 50 % | L (for cryptographic + migration tooling) |
| 3.3 RBAC/ABAC | PARTIAL (RBAC done; ABAC pending) | 45 % | XL (ABAC/OPA) |
| 3.4 GIS | IN PROGRESS (substrate + tiles + map, P2.7–P2.9) | 28 % | XXL |
| 3.5 Analytics | PARTIAL (CH projections + query API, P2.2/P2.5/P2.6) | 24 % | XL |
| 3.6 Realtime Events | PARTIAL (NATS outbox + relay + consumers + WS, P2.1–P2.5) | 48 % | L → XL |
| 3.7 Dashboard Builder | NOT STARTED | 0 % | L |
| 3.8 File Mgmt | PARTIAL | 20 % | XL |
| 3.9 ECM | PARTIAL | 10 % | XL |
| 3.10 Workflow | PARTIAL (Temporal + visual builder, P3.1/P3.2/P3.8) | 16 % | XL |
| 3.11 Chat | MVP DONE (P3.12 a–b) | 45 % | XL |
| 3.12 Video | DONE — MVP (P4.2 a–c) | 65 % | XXL |
| 3.13 Notifications | P1.6 DONE (a–c) | 60 % | L |
| 3.14 Search | PARTIAL (federated search, P3.6/P3.7) | 30 % | XL |
| 3.15 Audit | PARTIAL | 85 % | L |
| 3.16 Wiki | MVP DONE (P3.10 a–c) | 40 % | XL |
| 3.17 API Gateway | PARTIAL (in-app API keys + OpenAPI) | 40 % | L → XL |
| 3.18 AI Readiness | NOT STARTED | 2 % | XXL |
| 3.19 Admin Panel | P1.4 DONE (a–d) | 60 % | L |
| 3.20 Observability | IN PROGRESS (logs + metrics + traces) | 55 % | L → XL |
| 3.21 Import/Export | PARTIAL (import side, P3.11 a–b) | 30 % | XL |
| 3.22 Realtime Collab | DONE — MVP (P4.1 a–c) | 70 % | XL |
| 3.23 Cases | IN PROGRESS (backend, P2.10) | 45 % | L (web UI + SLA/types/links) |
| 3.24 Media | DONE (a–c, P4.5) | 80 % | L |
| 3.25 Geo Analytics | NOT STARTED | 0 % | sub-scope of 3.4 |
| 3.26 Ops Monitoring | DONE — MVP (P4.3 a–c) | 60 % | XL |
| 3.27 Incidents | P1.5 DONE (a–c) | 55 % | L → XL |

**Aggregate completion against ToR §3 surface:** ~**6 %**.
This is **the right number for a Phase-1 foundation that has not yet entered Phase 2**.

See [PRIORITY_EXECUTION_PLAN.md](./PRIORITY_EXECUTION_PLAN.md) for sequencing of remaining work.
