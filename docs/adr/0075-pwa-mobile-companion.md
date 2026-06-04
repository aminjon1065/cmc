# ADR-0075: Mobile companion — PWA with offline incident capture

**Status:** Accepted
**Date:** 2026-06-03
**Implements:** PRIORITY_EXECUTION_PLAN P4.4 (mobile companion — deferred from Horizon P4)
**Builds on:** the Next.js web app + BFF (P0–P4), incidents create server action (P1.5b), single-site reality (P4.6)

## Context

P4.4 (mobile companion) was deferred pending a **PWA vs React Native** decision.
The reality decides it: **single-site, sovereign, often air-gapped** КЧС — clients
connect to the one HQ server, and field users have flaky connectivity. A native
RN app needs an app store or sideloading (hostile to air-gap) and a second
codebase; a **PWA** reuses the entire existing Next.js app + BFF + auth, installs
without a store, and works offline. Forks locked with the user: **PWA on the
current Next.js** + first slice = **PWA foundation + offline incident capture**.

## Decision

### PWA foundation

- `app/manifest.ts` (typed `MetadataRoute.Manifest`, branding-driven name) →
  Next auto-serves `/manifest.webmanifest`; installable, `display: standalone`.
- `public/icon.svg` (maskable-safe), `viewport.themeColor` in the root layout.
- `public/sw.js` — a **conservative** service worker: precache the offline
  fallback + icon + manifest; **navigations are network-first** with a
  `/offline` fallback; precached static assets are cache-first; **API/RSC
  requests are untouched** so Next data/navigation are never served stale.
- `app/offline/page.tsx` — static offline fallback (RU + EN).
- `components/pwa-register.tsx` (client, mounted once in the root layout):
  registers the SW, tracks online/offline + the queue depth (a small status
  badge), and **drains the offline queue on reconnect**.

### Offline incident capture

- `lib/offline-incidents.ts` — an IndexedDB queue (`queue/list/remove/count`).
- The create-incident form: when `navigator.onLine` is false **or** the server
  action throws mid-submit (server unreachable), the draft is persisted to
  IndexedDB and the user is returned to the list (a "queued offline" badge shows).
- On reconnect (`online` event / app open) `PwaRegister` replays each queued
  draft through the **same `createIncidentAction` server action** — so offline
  creates go through the identical BFF + RLS + audit path. A draft is dropped
  once the server is reached (success or a permanent validation reject); a pure
  network failure stops the drain to retry on the next reconnect.

## Consequences

- **Positive:** one codebase, installable, no app store (air-gap friendly);
  offline app-shell + offline incident capture for field users; offline creates
  reuse the existing auth/BFF/RLS/audit (no parallel API surface); the SW is
  deliberately minimal so it can't break Next navigation.
- **Negative / trade-offs:** **incident capture only** offline (other writes are
  online-only this slice — full offline-first is a follow-on); the SW caches an
  offline *shell*, not the full app (cached routes are network-first); the queue
  has no conflict resolution (creates are append-only, so none needed yet);
  offline drafts live unencrypted in IndexedDB on the device (acceptable for
  incident reports; sensitive-field handling is a follow-on); SVG-only icon
  (broad but not every legacy launcher).

## Validation

- Web **tsc ✓ + lint ✓ + `next build` ✓** (29/29 routes incl. the generated
  `/manifest.webmanifest`, `/offline`). The app is `output: "standalone"`, so a
  `next start` runtime smoke does **not** apply (the deploy serves
  `.next/standalone/server.js`); auth/middleware were untouched, so the 307/401
  redirect behaviour is unchanged. Backend untouched → its suite unaffected.
- **Boundary:** install prompt, service-worker offline navigation, and the
  IndexedDB queue→reconnect→sync flow are a **manual browser live-smoke**
  (DevTools "Offline" + Application panel) — not curl/CI-testable.

## Files

- `apps/web/src/app/manifest.ts`, `apps/web/src/app/offline/page.tsx`,
  `apps/web/public/{sw.js,icon.svg}`, `apps/web/src/components/pwa-register.tsx`,
  `apps/web/src/lib/offline-incidents.ts`, `apps/web/src/app/layout.tsx`
  (viewport + `<PwaRegister/>`), `apps/web/src/app/incidents/create-incident-form.tsx`
  (offline queueing).

## Follow-ons

- Offline capture for more modules (cases, field notes) + a managed offline cache
  of recently-viewed records (read offline-first).
- Web Push notifications (the SW is now in place); background-sync API for the
  queue drain; conflict handling if offline edits (not just creates) are added.
- Per-device encryption of queued drafts; PNG icon set for legacy launchers;
  install-prompt UX.
