import Link from "next/link";
import {
  Activity,
  BarChart3,
  Bot,
  Briefcase,
  FileText,
  Files,
  Folder,
  Globe2,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  Network,
  Radio,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import { Emblem } from "./emblem";

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
      { id: "command", label: "Command Center", icon: Radio, disabled: true },
      {
        id: "monitor",
        label: "Realtime Monitoring",
        icon: Activity,
        disabled: true,
      },
      { id: "gis", label: "GIS Map", icon: Globe2, disabled: true },
      { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
    ],
  },
  {
    id: "intel",
    label: "Intelligence",
    items: [
      { id: "analytics", label: "Analytics", icon: BarChart3, disabled: true },
      { id: "ai", label: "AI Assistant", icon: Sparkles, disabled: true },
      { id: "search", label: "Search", icon: Search, disabled: true },
    ],
  },
  {
    id: "work",
    label: "Work",
    items: [
      { id: "workflow", label: "Workflows", icon: Network, disabled: true },
      { id: "cases", label: "Cases & Incidents", icon: Briefcase, disabled: true },
    ],
  },
  {
    id: "know",
    label: "Knowledge",
    items: [
      { id: "docs", label: "Documents", icon: FileText, href: "/documents" },
      { id: "files", label: "Files", icon: Folder, disabled: true },
      { id: "wiki", label: "Knowledge Base", icon: Files, disabled: true },
    ],
  },
  {
    id: "comms",
    label: "Communication",
    items: [
      { id: "chat", label: "Chat", icon: MessageSquare, disabled: true },
      { id: "video", label: "Video", icon: Video, disabled: true },
      { id: "notif", label: "Notifications", icon: Inbox, disabled: true },
    ],
  },
  {
    id: "sys",
    label: "System",
    items: [
      { id: "admin", label: "Administration", icon: ShieldCheck, disabled: true },
      { id: "audit", label: "Audit", icon: Shield, disabled: true },
      { id: "tenant", label: "Tenants", icon: Users, disabled: true },
    ],
  },
];

export function Sidebar({
  active,
  user,
}: {
  active?: string;
  user?: { name?: string | null; role?: string | null } | null;
}) {
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
            Crisis Management Center
          </div>
          <div
            className="text-[9.5px] leading-tight"
            style={{ color: "var(--c-fg-3)", letterSpacing: "0.04em" }}
          >
            Civil Defense · TJ
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
              {group.label}
            </div>
            {group.items.map((item) => {
              const isActive = active === item.id;
              const Icon = item.icon;
              const content = (
                <span
                  className="relative flex items-center gap-2.5 rounded-md px-2 py-1 text-[12px]"
                  style={{
                    background: isActive ? "var(--c-bg-3)" : "transparent",
                    color: isActive
                      ? "var(--c-fg-1)"
                      : item.disabled
                        ? "var(--c-fg-4)"
                        : "var(--c-fg-2)",
                    fontWeight: isActive ? 500 : 400,
                    cursor: item.disabled ? "not-allowed" : "pointer",
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
                  <span className="truncate">{item.label}</span>
                </span>
              );
              if (item.href && !item.disabled) {
                return (
                  <Link key={item.id} href={item.href as never}>
                    {content}
                  </Link>
                );
              }
              return (
                <div
                  key={item.id}
                  aria-disabled={item.disabled || undefined}
                  title={item.disabled ? "Coming soon" : undefined}
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
            {user?.name ?? "Signed-out"}
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
