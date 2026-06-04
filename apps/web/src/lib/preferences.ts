"use server";

import { cookies } from "next/headers";
import { authedApiFetch } from "./server-api";
import { THEME_COOKIE, isTheme, type Theme } from "./theme";
import { LOCALE_COOKIE, isLocale, type Locale } from "@/i18n/config";

const YEAR = 60 * 60 * 24 * 365;

/**
 * Persist the chosen UI theme/locale to the signed-in user's profile
 * (`PATCH /v1/me/preferences`, ADR-0078) so it follows them across
 * browsers/devices. Best-effort: the cookie remains the runtime source, so a
 * failed PATCH (e.g. offline) never blocks the instant local switch.
 */
export async function saveThemePreference(theme: Theme): Promise<void> {
  try {
    await authedApiFetch("/me/preferences", {
      method: "PATCH",
      body: JSON.stringify({ theme }),
    });
  } catch {
    /* best-effort — cookie already applied client-side */
  }
}

export async function saveLocalePreference(locale: Locale): Promise<void> {
  try {
    await authedApiFetch("/me/preferences", {
      method: "PATCH",
      body: JSON.stringify({ locale }),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * On login: pull the user's saved preferences and seed the runtime cookies, so
 * a fresh browser/device picks up their theme + language. Best-effort.
 */
export async function syncPreferencesToCookies(): Promise<void> {
  let prefs: { theme?: string | null; locale?: string | null } | null = null;
  try {
    prefs = await authedApiFetch<{
      theme?: string | null;
      locale?: string | null;
    }>("/me/preferences");
  } catch {
    return;
  }
  const store = await cookies();
  if (prefs?.locale && isLocale(prefs.locale)) {
    store.set(LOCALE_COOKIE, prefs.locale, {
      path: "/",
      maxAge: YEAR,
      sameSite: "lax",
    });
  }
  if (prefs?.theme && isTheme(prefs.theme)) {
    store.set(THEME_COOKIE, prefs.theme, {
      path: "/",
      maxAge: YEAR,
      sameSite: "lax",
    });
  }
}
