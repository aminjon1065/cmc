# ADR-0078: User-profile UI preferences (theme + locale) + "system" theme mode

**Status:** Accepted
**Date:** 2026-06-04
**Implements:** "remember theme/language in the user profile; add a `system`
(prefers-color-scheme) theme mode."
**Builds on:** i18n (ADR-0076), theming (ADR-0077), users/auth (P1.x).

## Context

Theme + locale were **cookie-only** — per-browser, lost on a new device. The
ask: persist them to the **user profile** (cross-device) and add a **`system`**
theme that follows the OS `prefers-color-scheme`.

## Decision

### Backend — self-service preferences
- `users.ui_theme` + `users.ui_locale` — nullable `varchar(8)` columns
  (migration **0043**, no new RLS: they inherit the `users` table's tenant RLS).
  `NULL` = no explicit choice.
- Contracts (`preferences.ts`): `UI_THEMES = [light,dark,system]`,
  `UI_LOCALES = [ru,tg]`, `UserPreferencesResponse`,
  `UpdateUserPreferencesRequest` (both optional; `null` clears).
- `UsersService.getMyPreferences/updateMyPreferences` (ambient tenant tx, scoped
  to the caller's `userId`). `PreferencesController` → **`GET/PATCH
  /v1/me/preferences`**, `@UseGuards(JwtAuthGuard)` only — personal, no
  `@Authorize` permission (like `/auth/me`). DTO via class-validator
  (`@IsOptional @IsIn`); the global `ValidationPipe`
  (whitelist + forbidNonWhitelisted) rejects bad enums / unknown keys (400).

### Frontend — system mode + profile sync (cookie = runtime source)
- Theme is now `light | dark | system` (default `light`). A **pre-paint inline
  script** in the root layout applies the `.dark` class from the `theme` cookie
  **before first paint**, resolving `system` via `matchMedia` (no flash); the
  server additionally sets the class for an explicit `dark` cookie (zero-flash
  for that common case).
- `ThemeToggle` — a 3-state cycle (Sun/Moon/Monitor) that applies the class
  instantly, writes the cookie, **live-tracks OS changes** while in `system`, and
  **PATCHes the profile** (`saveThemePreference`).
- `LanguageSwitcher`'s `setLocale` server action now also PATCHes the profile.
- **On login**, `LoginForm` calls `syncPreferencesToCookies` (server action) →
  reads `GET /me/preferences` and seeds the `NEXT_LOCALE` + `theme` cookies, so a
  fresh browser/device picks up the user's saved theme + language before the
  first render.

**Precedence:** the cookie is the runtime source; the profile **seeds** it on
login and is **updated** on every toggle/switch. Two simultaneously-open devices
don't live-sync — the next login picks up the change. Profile writes are
best-effort (a failed PATCH never blocks the instant local switch).

## Consequences

- **Positive:** theme + language follow the user across browsers/devices;
  `system` mode follows the OS, live; no theme flash; one self-service endpoint,
  no new permission; columns inherit existing RLS.
- **Negative / trade-offs:** cookie (not profile) is read per-request — a change
  on device A reaches device B only at its next login; the login→cookie sync runs
  client-side after `signIn` (a raw API login bypasses it — browser-only); theme
  is a single global per-user pref (not per-tenant); `system` users may see a
  one-frame flash on first paint (pre-paint script is body-top, not `<head>`).

## Validation

- Backend **tsc ✓**, **e2e 8/8** (`preferences.e2e-spec.ts`: defaults, set/get,
  partial patch, clear-with-null, enum 400, whitelist 400, 401, per-user
  isolation) + live API round-trip (GET null→PATCH dark/tg→GET reflects→bad
  enum 400). Migration 0043 auto-applied to `cmc_test` (global-setup) + manually
  to dev `cmc`.
- Web **tsc ✓ + lint ✓ + `next build` ✓**; ru↔tg parity 726/726. Live curl:
  default light (no `.dark`), `theme=dark`→`.dark`, `theme=system`→no server
  class + pre-paint script present; 3-state toggle renders (`aria-label="Тема:
  …"`); authed `/dashboard` 200.

## Files

- DB: `packages/db/src/schema/users.ts` (+ columns), `migrations/0043_*.sql`.
- Contracts: `packages/contracts/src/preferences.ts` (+ index export).
- API: `apps/api/src/modules/users/{preferences.controller.ts,users.service.ts,
  dto/update-preferences.dto.ts,users.module.ts}`,
  `apps/api/test/e2e/preferences.e2e-spec.ts`.
- Web: `src/lib/{theme.ts,preferences.ts}`,
  `src/components/cmc/{theme-toggle,topbar}.tsx`, `src/app/layout.tsx`
  (pre-paint script), `src/components/login-form.tsx`,
  `src/i18n/locale-actions.ts`, `messages/{ru,tg}.json` (`topbar.themeMode`).

## Follow-ons (optional)

- Live cross-device sync (push or poll) instead of login-time seeding.
- Move the pre-paint script to `<head>` for a guaranteed zero-flash `system`.
- Per-user `prefers-reduced-motion`/density prefs reusing the same endpoint.
