"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { THEME_COOKIE, THEMES, type Theme } from "@/lib/theme";
import { saveThemePreference } from "@/lib/preferences";

/** Resolve + apply the `.dark` class for a theme (system → matchMedia). */
function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Light/dark/system theme toggle (ADR-0077 + ADR-0078). Cycles
 * light → dark → system, applies the class instantly (no reload), persists the
 * choice in a cookie (read server-side on the next request) and — for signed-in
 * users — in their profile. In `system` mode it live-tracks OS changes.
 */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const t = useTranslations("topbar");
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  function cycle() {
    const next: Theme =
      THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "light";
    setTheme(next);
    applyTheme(next);
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    void saveThemePreference(next);
  }

  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = `${t("theme")}: ${t(`themeMode.${theme}`)}`;

  return (
    <button
      type="button"
      onClick={cycle}
      className="cmc-btn cmc-btn-ghost"
      style={{ padding: "0 6px" }}
      aria-label={label}
      title={label}
    >
      <Icon size={13} strokeWidth={1.7} />
    </button>
  );
}
