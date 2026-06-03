# ADR-0061: Video conferencing (LiveKit) — gated SFU seam, room-scoped tokens, recording, incident links

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P4.2 (a — substrate; b — web join; c — recording + incident links)
**Depends on:** RBAC (P1.1 / ADR-0019), object storage (S3/MinIO, ADR-0042), BFF auth posture, gated-lazy-seam pattern (Temporal ADR-0045, Hocuspocus ADR-0060)

## Context

ToR §3.12 calls for video conferencing — multi-party audio/video with screen
share, recording, and (eventually) calendar scheduling — for crisis coordination.
WebRTC at any quality needs an SFU; LiveKit is the proven self-hostable option
(SFU + TURN via coturn + a separate egress service for recording).

Constraints carried from the rest of the platform: don't pollute the jest runtime
or the request path with a heavy media stack; keep tenant isolation + RBAC; and —
the recurring one — never hand the browser the platform access JWT (BFF posture).
LiveKit's own access token is room-scoped and short-lived, so it is safe to give
to the browser; the platform JWT is not.

## Decision

### 1. Gated LiveKit seam; rooms are our metadata, the SFU room auto-creates (P4.2a)

`VideoService` dynamic-imports `livekit-server-sdk` (gated lazy seam) and runs
only what's needed: **token minting is pure JWT signing** with the LiveKit API
key/secret, so it works — and stays e2e-testable — without a running SFU; the
room-admin / egress RPCs are best-effort and only used when `LIVEKIT_ENABLED`.
`video_rooms` (RLS, migration 0035) is our metadata; the actual SFU room is
auto-created by LiveKit when the first participant joins with a valid token, so
no admin call is needed to start a call. Rooms are **standalone** with reserved
`linked_type`/`linked_id` for attaching to a domain entity. Perms `video:read`
/`write`/`manage`. LiveKit + coturn run as **gated dev containers** (keys in
`infra/livekit/livekit.yaml` match the API config).

### 2. Browser joins with a room-scoped LiveKit token via the BFF (P4.2b)

`POST /v1/video/rooms/:id/token` (`@Authorize("video:write")`) mints an
`AccessToken` (identity = user id, `roomJoin` grant for the room, publish/
subscribe). The web fetches it through a BFF route (`/api/video/token`, bearer
attached server-side) and mounts LiveKit's prebuilt `<VideoConference>` (grid,
device controls, screenshare) — loaded `next/dynamic({ ssr: false })` because
`livekit-client` is browser-only. If `LIVEKIT_ENABLED` is false the response
carries `enabled:false` and the UI shows an "unavailable" fallback rather than
hanging.

### 3. Recording: manual start/stop via egress → S3 (P4.2c)

A `video:manage` user starts/stops recording from the in-call UI. `startRecording`
issues a LiveKit **RoomCompositeEgress** that composites the room and uploads an
MP4 to S3/MinIO (the S3 target is supplied per-request; the egress container
reaches MinIO at an internal endpoint). Metadata lives in `video_recordings`
(RLS, migration 0036); download is a presigned GET via the existing
StorageService. Egress requires the (heavy, headless-Chrome) egress service, so
it's an **opt-in `egress` compose profile**; when disabled, `startRecording`
returns 503. Manual (not auto-record) was chosen for privacy + storage control.

### 4. Rooms linked to incidents (P4.2c)

`video_rooms.linked_type`/`linked_id` are activated: `createRoom` accepts a link,
`GET /v1/video/rooms?linkedType=&linkedId=` filters by it, and the incident
detail page gets a "Start video call" affordance + a list of the incident's open
calls (→ `/video?join=<id>` auto-joins). Cases get the same widget once their
detail page exists (their web UI is a separate follow-on).

## Consequences

- **Positive:** real multi-party AV with screenshare + recording; tenant-isolated,
  RBAC-gated, audited; the access JWT never reaches the browser; the heavy media
  stack stays out of the default test runtime and is opt-in even in dev.
- **Negative / trade-offs:** single-node LiveKit (no SFU clustering yet); egress
  is resource-heavy and opt-in; real WebRTC media + egress are not headless-
  testable, so they're covered by manual/Playwright smokes, not the default suite.

## Validation

- e2e `video` **9/9**: room CRUD; room-scoped token mint + JWT-grant decode; RBAC;
  tenant isolation (RLS); link both-or-neither + filter; close + closed-room 409;
  recording start gating (403 без `video:manage`, 503 when egress off) + recordings
  list; recording download presigned URL + cross-tenant 404.
- **Live smoke**: a real LiveKit SFU accepts the dev key via `RoomServiceClient`
  (validates `livekit.yaml` ↔ API key alignment).
- Web `tsc`/`lint`/`build` green; smoke `/video`→307 login + `/api/video/token`→401.
  Full backend suite **55 suites / 407 tests**, zero regressions.
- **Manual (egress profile):** `docker compose --profile egress up -d` then start a
  recording from a live call → an MP4 lands in MinIO under `recordings/`.

## Files

- Backend: `apps/api/src/modules/video/` (`video.service.ts`, `video.controller.ts`,
  `video.module.ts`), `packages/db/src/schema/video-rooms.ts` + `video-recordings.ts`
  (migrations 0035, 0036), `packages/contracts/src/video.ts`, `video:*` perms,
  `LIVEKIT_*` config.
- Infra: `infra/livekit/{livekit.yaml,egress.yaml}`, `livekit`/`coturn`/`livekit-egress`
  (profile) services in `infra/docker-compose.yml`.
- Web: `apps/web/src/app/video/`, `apps/web/src/app/api/video/token/`,
  `apps/web/src/app/incidents/[id]/incident-video.tsx`.

## Follow-ons

- SFU clustering / multi-node LiveKit + Redis for HA scale.
- Calendar scheduling of rooms; case detail "Start call" (when the case web UI lands).
- Per-participant recording / track egress; recording retention + legal hold.
- Playwright two-browser media smoke.
