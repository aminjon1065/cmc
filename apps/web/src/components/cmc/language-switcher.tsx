"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Languages } from "lucide-react";
import { locales, LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { setLocale } from "@/i18n/locale-actions";

/** Topbar language picker (RU/TG). Writes the locale cookie + refreshes. */
export function LanguageSwitcher() {
  const router = useRouter();
  const active = useLocale();
  const t = useTranslations("locale");
  const [pending, startTransition] = useTransition();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as Locale;
    if (next === active) return;
    // Set the cookie client-side first so the language switches on refresh even
    // if the server action is stale/unavailable; setLocale also persists it to
    // the profile (best-effort).
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    startTransition(async () => {
      try {
        await setLocale(next);
      } catch {
        /* best-effort — cookie already set client-side */
      }
      router.refresh();
    });
  }

  return (
    <label
      className="flex items-center gap-1.5 text-[11px]"
      style={{ color: "var(--c-fg-2)" }}
      title={t("label")}
    >
      <Languages
        size={12}
        strokeWidth={1.7}
        style={{ color: "var(--c-fg-3)" }}
      />
      <select
        value={active}
        onChange={onChange}
        disabled={pending}
        aria-label={t("label")}
        className="cmc-input"
        style={{ height: 24, padding: "0 6px", fontSize: 11 }}
      >
        {locales.map((l) => (
          <option key={l} value={l}>
            {t(l)}
          </option>
        ))}
      </select>
    </label>
  );
}
