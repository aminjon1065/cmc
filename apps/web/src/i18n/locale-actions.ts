"use server";

import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE, type Locale } from "./config";
import { authedApiFetch } from "@/lib/server-api";

/**
 * Persist the chosen UI language: a cookie (runtime source) plus, best-effort,
 * the signed-in user's profile (ADR-0078) so it follows them across devices.
 * The switcher calls this, then refreshes the router so server components
 * re-render with the new locale.
 */
export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  try {
    await authedApiFetch("/me/preferences", {
      method: "PATCH",
      body: JSON.stringify({ locale }),
    });
  } catch {
    /* best-effort — cookie already set */
  }
}
