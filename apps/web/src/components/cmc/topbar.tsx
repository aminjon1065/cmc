import { ChevronRight, Search } from "lucide-react";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { SignOutButton } from "@/components/sign-out-button";
import { NotificationBell } from "@/components/cmc/notification-bell";
import { LanguageSwitcher } from "@/components/cmc/language-switcher";
import { ThemeToggle } from "@/components/cmc/theme-toggle";
import { THEME_COOKIE, isTheme, defaultTheme } from "@/lib/theme";
import { getNotificationsAction } from "@/app/notifications/actions";

export async function Topbar({
  crumbs = [],
  tenant,
}: {
  crumbs?: string[];
  tenant?: string | null;
}) {
  const { items, unreadCount } = await getNotificationsAction({ limit: 8 });
  const t = await getTranslations("topbar");
  const themeCookie = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isTheme(themeCookie) ? themeCookie : defaultTheme;
  return (
    <div
      className="flex h-11 shrink-0 items-center gap-3 px-3.5"
      style={{
        background: "var(--c-bg-1)",
        borderBottom: "0.5px solid var(--c-line-2)",
      }}
    >
      <div className="flex items-center gap-1.5 text-[12px]">
        <span style={{ color: "var(--c-fg-3)" }}>{t("operations")}</span>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <ChevronRight
              size={12}
              strokeWidth={1.6}
              style={{ color: "var(--c-fg-4)" }}
            />
            <span
              style={{
                color:
                  i === crumbs.length - 1 ? "var(--c-fg-1)" : "var(--c-fg-2)",
              }}
            >
              {c}
            </span>
          </span>
        ))}
      </div>

      <div className="ml-4 max-w-sm flex-1">
        <div
          className="flex h-6 items-center gap-2 rounded-md px-2.5 text-[11.5px]"
          style={{
            background: "var(--c-bg-2)",
            border: "0.5px solid var(--c-line-2)",
            color: "var(--c-fg-4)",
          }}
        >
          <Search size={12} strokeWidth={1.6} style={{ color: "var(--c-fg-3)" }} />
          <span className="flex-1">{t("searchPlaceholder")}</span>
          <span className="cmc-kbd">⌘K</span>
        </div>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2.5">
        <div
          className="flex items-center gap-1.5 text-[11px]"
          style={{ color: "var(--c-fg-2)" }}
        >
          <span
            className="cmc-dot cmc-dot-pulse"
            style={{
              background: "var(--c-ok)",
              color: "var(--c-ok)",
            }}
          />
          {t("realtime")}
        </div>
        <span
          className="h-4 w-px"
          style={{ background: "var(--c-line-2)" }}
        />
        {tenant && (
          <>
            <span className="cmc-chip cmc-chip-accent">{tenant}</span>
            <span
              className="h-4 w-px"
              style={{ background: "var(--c-line-2)" }}
            />
          </>
        )}
        <NotificationBell initialCount={unreadCount} initialItems={items} />
        <span
          className="h-4 w-px"
          style={{ background: "var(--c-line-2)" }}
        />
        <ThemeToggle initial={theme} />
        <span
          className="h-4 w-px"
          style={{ background: "var(--c-line-2)" }}
        />
        <LanguageSwitcher />
        <span
          className="h-4 w-px"
          style={{ background: "var(--c-line-2)" }}
        />
        <SignOutButton />
      </div>
    </div>
  );
}
