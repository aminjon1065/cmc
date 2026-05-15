import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell({
  active,
  crumbs,
  user,
  tenant,
  children,
}: {
  active?: string;
  crumbs?: string[];
  user?: { name?: string | null; role?: string | null } | null;
  tenant?: string | null;
  children: ReactNode;
}) {
  return (
    <div
      className="flex h-screen w-screen overflow-hidden"
      style={{ background: "var(--c-bg-0)", color: "var(--c-fg-1)" }}
    >
      <Sidebar active={active} user={user} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar crumbs={crumbs} tenant={tenant} />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
