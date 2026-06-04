# ADR-0077: Web theming — light default + dark toggle (CSS-variable, cookie-driven)

**Status:** Accepted
**Date:** 2026-06-04
**Implements:** UI theming request — make the interface light by default, keep
dark, let users switch.
**Builds on:** the design-token system in `globals.css`, Tailwind
`darkMode: "class"`, i18n cookie pattern (ADR-0076).

## Context

The operator UI shipped **dark-only**: the `--c-*` design tokens (and the
shadcn HSL set) were defined directly in `:root`, and the root layout hardcoded
`class="dark"`. The user wants **light as the main/default theme**, with dark
**kept** and a **toggle** so users can switch.

The whole UI already paints from CSS variables (`var(--c-*)`) + shadcn HSL
tokens, and Tailwind is `darkMode: "class"`. So theming is a token-swap, not a
component rewrite.

## Decision

### Token split (globals.css)
- `:root` now holds the **LIGHT** palette (default): cool-gray page
  (`--c-bg-0:#f0f3f7`), white chrome + cards (`--c-bg-1/2:#fff`), gray
  chips/hover, near-black text, and **deepened** accent/status colors
  (`--c-accent:#2f6fe0`, sev/ok/info/violet darkened) for legibility on white.
- `.dark` holds the **DARK** palette (the original dark-first values, moved
  verbatim). Both rule-sets target `<html>`; `.dark` follows `:root` in source
  so it wins when present (equal specificity).
- `color-scheme: light` / `dark` per theme so native controls (date pickers,
  checkboxes, scrollbars) match. `--radius` stays in `:root` (theme-independent).

### Theme selection (cookie, no flash)
- `lib/theme.ts`: `THEME_COOKIE = "theme"`, `defaultTheme = "light"`,
  `isDark()`.
- Root `layout.tsx` reads the `theme` cookie server-side and adds the `dark`
  class to `<html>` **only** when it's `"dark"` — so the correct theme is in the
  first paint (no flash). Default/unset → light.
- `components/cmc/theme-toggle.tsx` (topbar, client): a sun/moon button that
  flips `.dark` on `<html>` **instantly** (no reload) and writes the `theme`
  cookie (1-year, `sameSite=lax`, client-set so SSR reads it next request).
  Mounted next to the language switcher; `initial` theme passed from the topbar
  (server reads the same cookie) so the icon matches with no hydration mismatch.
- `topbar.theme` message added (RU «Тема» / TG «Мавзӯъ»). Tailwind
  `darkMode: "class"` already keys `dark:` utilities off the same class.

## Consequences

- **Positive:** light by default, dark one click away; no theme flash (cookie →
  SSR class); instant switch (client class flip); every CSS-var/shadcn component
  adapts automatically; no per-component changes.
- **Negative / trade-offs:** theme is per-browser (cookie), **not yet persisted
  to the user profile**; `viewport.themeColor` is static (set to the light bg).
  (The PWA offline badge, the minimal MapLibre basemap, and the PWA manifest
  colours were initially dark-only but are now theme-aware — see Update below.)

## Validation

- Web **tsc ✓ + lint ✓ + `next build` ✓**; ru↔tg message parity 722/722.
- **Live curl:** default (no cookie) → `<html>` has **no** `dark` class (light);
  `theme=dark` cookie → `<html class="dark …">` (dark); the topbar theme toggle
  (`aria-label="Тема"`) renders on authed pages; login is light by default.

## Files

- `apps/web/src/app/globals.css` (`:root` light + `.dark` dark + `color-scheme`),
  `apps/web/src/lib/theme.ts`, `apps/web/src/components/cmc/theme-toggle.tsx`,
  `apps/web/src/app/layout.tsx` (cookie → `dark` class + `viewport.themeColor`),
  `apps/web/src/components/cmc/topbar.tsx` (toggle), `apps/web/messages/{ru,tg}.json`
  (`topbar.theme`).

## Update (2026-06-04)

The initially dark-only spots are now **theme-aware**:
- **MapLibre basemap** (`map-view.tsx`): the minimal self-contained style's
  backdrop follows the theme (light `#e6ebf2` / dark `#0b0f14`) and **re-tints
  live on toggle** via a `MutationObserver` on the `<html>` class
  (`setPaintProperty`). External `NEXT_PUBLIC_MAP_STYLE_URL` styles are left as-is.
- **PWA offline/sync badge** (`pwa-register.tsx`): paints from
  `var(--c-bg-2)`/`var(--c-fg-1)` + `var(--c-line-2)` border (amber
  `var(--c-sev-2)` when offline) instead of hardcoded dark hex.
- **PWA manifest** (`app/manifest.ts`): `theme_color` + `background_color` →
  light `#f0f3f7`.

## Follow-ons (optional)

- Persist the chosen theme to the **user profile** (server-side) alongside the
  cookie; optional "system" (prefers-color-scheme) mode.
- ~~Light-aware MapLibre basemap + PWA offline badge + PWA manifest~~ — **done**
  (2026-06-04). Remaining: per-theme `viewport.themeColor` via `generateViewport`.
- Audit any remaining hardcoded hex in inline styles for theme-awareness.
