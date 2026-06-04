/**
 * Theme config (ADR-0077, extended ADR-0078). Three modes — light (default),
 * dark, and **system** (follows `prefers-color-scheme`). The choice lives in a
 * `theme` cookie AND, for signed-in users, in their profile (synced into the
 * cookie on login). A pre-paint inline script in the root layout applies the
 * class before first paint (resolving `system` via `matchMedia`) so there's no
 * flash; the server additionally sets the class for an explicit `dark` cookie.
 */
export const THEME_COOKIE = "theme";
export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];
export const defaultTheme: Theme = "light";

export function isTheme(value: unknown): value is Theme {
  return (
    typeof value === "string" && (THEMES as readonly string[]).includes(value)
  );
}

/**
 * Server-side resolution: only an explicit `dark` cookie resolves to dark
 * before paint. `system` (and unset) is resolved on the client by the
 * pre-paint script via `matchMedia`, since the server has no OS signal.
 */
export function explicitDark(value: string | undefined): boolean {
  return value === "dark";
}
