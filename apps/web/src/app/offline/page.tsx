import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("offline");
  return { title: t("metaTitle") };
}

/**
 * Offline fallback (P4.4 / ADR-0075). Served by the service worker when a
 * navigation fails with no connectivity. Localized (RU/TG) via the i18n
 * catalog (ADR-0076). Queued incident reports sync automatically on reconnect.
 */
export default async function OfflinePage() {
  const t = await getTranslations("offline");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-2xl font-semibold">{t("title")}</div>
      <p className="max-w-sm text-sm opacity-70">{t("body")}</p>
    </main>
  );
}
