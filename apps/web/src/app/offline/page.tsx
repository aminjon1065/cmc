import type { Metadata } from "next";

export const metadata: Metadata = { title: "Offline" };

/**
 * Offline fallback (P4.4 / ADR-0075). Served by the service worker when a
 * navigation fails with no connectivity. Static (no data deps) so it's safely
 * precacheable. Queued incident reports sync automatically on reconnect.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-2xl font-semibold">Вы офлайн</div>
      <p className="max-w-sm text-sm opacity-70">
        Нет связи с сервером. Установленное приложение остаётся доступным.
        Созданные офлайн отчёты об инцидентах сохраняются на устройстве и
        отправятся автоматически при восстановлении связи.
      </p>
      <p className="max-w-sm text-xs opacity-50">
        You are offline — queued incident reports will sync on reconnect.
      </p>
    </main>
  );
}
