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
- System roles (`tenant_admin`/`operator`/`auditor`) seeded per tenant; documents `@Authorize`-protected per route. 9 e2e tests; live-validated.

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
- **MapLibre map (P2.9 / ADR-0039):** `/map` page + `MapView` (layer toggle + feature inspector); **BFF tile proxy** (`/api/gis/tiles/*`) keeps the API token server-side; configurable basemap. Build/types + proxy auth gate verified (visual render = human/browser)

**Gaps vs ToR §4**
- Geofencing, live-tracking pipeline, spatial analytics/clustering/heatmap, multi-CRS handling, tile caching/CDN; richer spatial ops (distance/within), import/export (GeoPackage/Shp); on-map editing; properties-schema enforcement; GIS domain events / realtime layer updates; a shipped basemap

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
| **Status** | NOT STARTED |
| **Compl. %** | 2 % (pgvector installed) |

No vector tables, no embedding workers, no LLM gateway, no RAG, no copilot infrastructure, no OCR, no LLM-call audit. **Complexity: XXL.**

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
| **Status** | NOT STARTED |

No transcoding workers, no FFmpeg pipeline, no HLS streaming, no signed URLs for media-specific access patterns. **Complexity: L.**

---

## 3.25 Geospatial Analytics

(Sub-scope of §3.4 / §4.) **NOT STARTED.**

---

## 3.26 Operational Monitoring Center

| field | value |
|---|---|
| **Status** | NOT STARTED |

This is the **product surface the UI implies**. No live event ticker, no multi-monitor layout, no real KPI tiles backed by data, no time-replay. The hero ribbon "ELEVATED ALERT · Flood Watch" is hardcoded copy. **Complexity: XL** (needs §3.6 events, §3.27 incidents, §3.4 GIS, §3.23 cases all in place).

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

### Vector plane (Qdrant / pgvector)

| | |
|---|---|
| Status | PARTIAL (pgvector installed, unused) |
| Blocks | §3.18 / §16 |
| Complexity | M to start indexing with pgvector; L to migrate to Qdrant when scale demands |

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
| Status | DEV MODE + first secret migrated (P2.14 / ADR-0044) — 2026-06-02 |
| Files | `apps/api/src/config/vault-secrets.ts` (loader), `src/main.ts` (dynamic AppModule import after overlay), `src/config/configuration.ts` (`VAULT_*`), `infra/docker-compose.yml` (`vault` dev + `vault-init`) |
| How | Gated in-process loader: `VAULT_ENABLED` → KV v2 read (`/v1/{mount}/data/{path}`, `X-Vault-Token`) → overlay keys into `process.env` before validation (Vault > `.env`). Off by default → pure-env no-op. Dev compose runs Vault dev mode (in-memory, root token) + seeds `secret/cmc/api` |
| First secret | **MFA_ENC_KEY** — `SecretBoxService` reads it via `config.get` unchanged |
| Tests | `apps/api/test/e2e/vault-secrets.e2e-spec.ts` — 5 hermetic (faked fetch+env). Live smoke: invalid env key + Vault on → boots; Vault off → fails |
| Gotcha | `ConfigModule.forRoot({ validate })` validates at module-import → `main.ts` imports `AppModule` dynamically after the overlay |
| Deferred | dynamic DB-creds engine + per-pod lease + renewal; AppRole/k8s auth (not static token); Vault Agent sidecar; runtime refresh; multi-path secrets |
| Blocks | hardened non-dev deployment (dynamic creds) |
| Complexity | M done; L remaining for dynamic engine + auth methods |

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

## Summary table

| Module | Status | Compl. % | Complexity to finish |
|---|---|---|---|
| 3.1 IAM | PARTIAL | 30 % | L |
| 3.2 Multi-Tenancy | DONE (shared-schema mode) | 50 % | L (for cryptographic + migration tooling) |
| 3.3 RBAC/ABAC | NOT STARTED | 0 % | L → XL |
| 3.4 GIS | IN PROGRESS (substrate + tiles + map, P2.7–P2.9) | 28 % | XXL |
| 3.5 Analytics | NOT STARTED | 0 % | XL |
| 3.6 Realtime Events | NOT STARTED | 0 % | L → XL |
| 3.7 Dashboard Builder | NOT STARTED | 0 % | L |
| 3.8 File Mgmt | PARTIAL | 20 % | XL |
| 3.9 ECM | PARTIAL | 10 % | XL |
| 3.10 Workflow | NOT STARTED | 0 % | XL |
| 3.11 Chat | NOT STARTED | 0 % | XL |
| 3.12 Video | NOT STARTED | 0 % | XXL |
| 3.13 Notifications | P1.6 DONE (a–c) | 60 % | L |
| 3.14 Search | NOT STARTED | 3 % | XL |
| 3.15 Audit | PARTIAL | 45 % | M |
| 3.16 Wiki | NOT STARTED | 0 % | XL |
| 3.17 API Gateway | NOT STARTED | 0 % | L → XL |
| 3.18 AI Readiness | NOT STARTED | 2 % | XXL |
| 3.19 Admin Panel | P1.4 DONE (a–d) | 60 % | L |
| 3.20 Observability | NOT STARTED | 5 % | L → XL |
| 3.21 Import/Export | NOT STARTED | 0 % | XL |
| 3.22 Realtime Collab | NOT STARTED | 0 % | XL |
| 3.23 Cases | IN PROGRESS (backend, P2.10) | 45 % | L (web UI + SLA/types/links) |
| 3.24 Media | NOT STARTED | 0 % | L |
| 3.25 Geo Analytics | NOT STARTED | 0 % | sub-scope of 3.4 |
| 3.26 Ops Monitoring | NOT STARTED | 0 % | XL |
| 3.27 Incidents | P1.5 DONE (a–c) | 55 % | L → XL |

**Aggregate completion against ToR §3 surface:** ~**6 %**.
This is **the right number for a Phase-1 foundation that has not yet entered Phase 2**.

See [PRIORITY_EXECUTION_PLAN.md](./PRIORITY_EXECUTION_PLAN.md) for sequencing of remaining work.
