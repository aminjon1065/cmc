/**
 * i18n configuration (RU default + TG). Locale is carried in a cookie — no
 * `/ru` URL prefix — so existing routes/middleware are untouched (ADR-0076).
 */
export const locales = ["ru", "tg"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "ru";

/** Cookie next-intl + the switcher read/write. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (locales as readonly string[]).includes(value)
  );
}
