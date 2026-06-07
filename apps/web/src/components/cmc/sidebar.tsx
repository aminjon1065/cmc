import Link from "next/link";
import {
  Activity,
  BarChart3,
  Briefcase,
  FileText,
  Files,
  Film,
  Globe2,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  Network,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  Upload,
  Video,
  type LucideIcon,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Emblem } from "./emblem";
import { getMyAccess, hasPermission, isAdmin } from "@/lib/access";

type NavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  disabled?: boolean;
};

type NavGroup = { id: string; label: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    id: "ops",
    label: "Operations",
    items: [
      {
        id: "monitor",
        label: "Realtime Monitoring",
        icon: Activity,
        href: "/monitoring",
      },
      { id: "gis", label: "GIS Map", icon: Globe2, href: "/map" },
      { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
    ],
  },
  {
    id: "intel",
    label: "Intelligence",
    items: [
      { id: "analytics", label: "Analytics", icon: BarChart3, href: "/analytics" },
      { id: "ai", label: "AI Assistant", icon: Sparkles, href: "/ai" },
      { id: "search", label: "Search", icon: Search, href: "/search" },
    ],
  },
  {
    id: "work",
    label: "Work",
    items: [
      { id: "workflow", label: "Workflows", icon: Network, href: "/workflows" },
      { id: "imports", label: "Data Import", icon: Upload, href: "/imports" },
      { id: "cases", label: "Cases & Incidents", icon: Briefcase, disabled: true },
    ],
  },
  {
    id: "know",
    label: "Knowledge",
    items: [
      { id: "docs", label: "Documents", icon: FileText, href: "/documents" },
      { id: "media", label: "Media", icon: Film, href: "/media" },
      { id: "wiki", label: "Knowledge Base", icon: Files, href: "/wiki" },
    ],
  },
  {
    id: "comms",
    label: "Communication",
    items: [
      { id: "chat", label: "Chat", icon: MessageSquare, href: "/chat" },
      { id: "video", label: "Video", icon: Video, href: "/video" },
      { id: "notif", label: "Notifications", icon: Inbox, disabled: true },
    ],
  },
  {
    id: "sys",
    label: "System",
    items: [
      { id: "admin", label: "Administration", icon: ShieldCheck, disabled: true },
      { id: "audit", label: "Audit", icon: Shield, href: "/audit" },
    ],
  },
];

export async function Sidebar({
  active,
  user,
  orgName = "Operational Intelligence Platform",
  orgShort = "Enterprise Operations",
}: {
  active?: string;
  user?: { name?: string | null; role?: string | null } | null;
  /** Branding header strings (P0.11) — generic defaults keep this usable
   *  without a tenant. */
  orgName?: string;
  orgShort?: string;
}) {
  // The Administration entry is only enabled for users who can manage the
  // tenant (P1.4a); the Incidents entry for users who can read incidents
  // (P1.5b). `getMyAccess()` is request-memoised, so this shares the round-trip
  // the /admin layout + page already make.
  const access = await getMyAccess();
  const canAdmin = isAdmin(access);
  const canIncidents = hasPermission(access, "incident:read");
  const canVideo = hasPermission(access, "video:read");
  const canMonitor = hasPermission(access, "monitoring:read");
  const canMedia = hasPermission(access, "media:read");
  const canLlm = hasPermission(access, "llm:use");
  const canAudit = hasPermission(access, "audit:read");

  // Localized nav labels (RU default + TG) — keyed by the stable group/item id.
  const tNav = await getTranslations("nav");
  const tCommon = await getTranslations("common");

  const initials = (user?.name ?? "")
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "··";

  return (
    <aside
      className="flex h-full shrink-0 flex-col gap-2.5 px-2.5 py-2.5"
      style={{
        width: 220,
        background: "var(--c-bg-1)",
        borderRight: "0.5px solid var(--c-line-2)",
      }}
    >
      <div className="flex items-center gap-2 px-1 py-1.5">
        <Emblem />
        <div className="min-w-0">
          <div
            className="truncate text-[11.5px] font-semibold leading-tight"
            style={{ color: "var(--c-fg-1)", letterSpacing: "-0.01em" }}
          >
            {orgName}
          </div>
          <div
            className="truncate text-[9.5px] leading-tight"
            style={{ color: "var(--c-fg-3)", letterSpacing: "0.04em" }}
          >
            {orgShort}
          </div>
        </div>
      </div>

      <nav className="flex flex-col gap-2.5">
        {NAV.map((group) => (
          <div key={group.id} className="flex flex-col gap-px">
            <div
              className="px-2 pb-0.5 pt-1 text-[9.5px] font-semibold uppercase"
              style={{
                color: "var(--c-fg-4)",
                letterSpacing: "0.08em",
              }}
            >
              {tNav(`groups.${group.id}`)}
            </div>
            {group.items.map((item) => {
              const isActive = active === item.id;
              const Icon = item.icon;
              // The Administration + Incidents entries are gated on the user's
              // permissions at render time; Notifications is open to everyone;
              // every other item keeps its static href/disabled.
              const href =
                item.id === "admin" && canAdmin
                  ? "/admin"
                  : item.id === "cases" && canIncidents
                    ? "/incidents"
                    : item.id === "media" && canMedia
                      ? "/media"
                      : item.id === "notif"
                        ? "/notifications"
                        : item.href;
              // Permission gate per nav id; absent ids keep their static
              // `disabled`. `notif` is open to everyone (true).
              const gate: Record<string, boolean> = {
                admin: canAdmin,
                cases: canIncidents,
                video: canVideo,
                monitor: canMonitor,
                media: canMedia,
                ai: canLlm,
                audit: canAudit,
                analytics: canIncidents,
                notif: true,
              };
              const disabled =
                item.id in gate ? !gate[item.id] : item.disabled;
              const content = (
                <span
                  className="relative flex items-center gap-2.5 rounded-md px-2 py-1 text-[12px]"
                  style={{
                    background: isActive ? "var(--c-bg-3)" : "transparent",
                    color: isActive
                      ? "var(--c-fg-1)"
                      : disabled
                        ? "var(--c-fg-4)"
                        : "var(--c-fg-2)",
                    fontWeight: isActive ? 500 : 400,
                    cursor: disabled ? "not-allowed" : "pointer",
                  }}
                >
                  {isActive && (
                    <span
                      className="absolute -left-2.5 top-1.5 bottom-1.5 w-0.5 rounded"
                      style={{ background: "var(--c-accent)" }}
                    />
                  )}
                  <Icon
                    size={14}
                    strokeWidth={1.6}
                    style={{
                      color: isActive ? "var(--c-accent)" : "var(--c-fg-3)",
                      flex: "0 0 auto",
                    }}
                  />
                  <span className="truncate">{tNav(`items.${item.id}`)}</span>
                </span>
              );
              if (href && !disabled) {
                return (
                  <Link key={item.id} href={href as never}>
                    {content}
                  </Link>
                );
              }
              return (
                <div
                  key={item.id}
                  aria-disabled={disabled || undefined}
                  title={disabled ? tCommon("comingSoon") : undefined}
                >
                  {content}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex-1" />

      <div
        className="flex items-center gap-2 px-1 py-2"
        style={{ borderTop: "0.5px solid var(--c-line-2)" }}
      >
        <div
          className="cmc-av"
          style={{
            background: "linear-gradient(135deg,#5b8def,#a78bfa)",
            border: 0,
          }}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[11.5px] font-medium"
            style={{ color: "var(--c-fg-1)" }}
          >
            {user?.name ?? tCommon("signedOut")}
          </div>
          <div
            className="truncate text-[10px]"
            style={{ color: "var(--c-fg-3)" }}
          >
            {user?.role ?? "—"}
          </div>
        </div>
      </div>
    </aside>
  );
}
