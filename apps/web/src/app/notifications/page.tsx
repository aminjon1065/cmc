import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  NotificationsListResponseSchema,
  type NotificationSummary,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { authedApiFetch } from "@/lib/server-api";
import { getTranslations } from "next-intl/server";
import { getPreferencesAction } from "./actions";
import { NotificationsView } from "./notifications-view";
import { NotificationPreferences } from "./notification-preferences";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("notifications");
  return { title: t("metaTitle") };
}

async function fetchNotifications(): Promise<NotificationSummary[]> {
  try {
    const raw = await authedApiFetch<unknown>("/notifications?limit=50");
    const parsed = NotificationsListResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data.notifications : [];
  } catch {
    return [];
  }
}

export default async function NotificationsPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const [items, preferences] = await Promise.all([
    fetchNotifications(),
    getPreferencesAction(),
  ]);

  return (
    <AppShell
      active="notif"
      crumbs={["Notifications"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Operations" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Notifications</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            Notifications
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <NotificationsView initial={items} />
        <NotificationPreferences initial={preferences} />
      </div>
    </AppShell>
  );
}
