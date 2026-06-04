"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { VideoRoom } from "@cmc/contracts";
import { createRoomAction, listLinkedRoomsAction } from "../../video/actions";

/**
 * "Start video call" affordance on an incident (P4.2c / ADR-0061). Lists the
 * incident's open linked rooms and lets a `video:write` user start a new call
 * (a room linked to this incident) → navigates to `/video?join=<id>` which
 * auto-joins. Cases get the same widget once their detail page exists.
 */
export function IncidentVideo({
  incidentId,
  summary,
  canStart,
}: {
  incidentId: string;
  summary: string;
  canStart: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("incidents");
  const [rooms, setRooms] = useState<VideoRoom[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listLinkedRoomsAction("incident", incidentId).then((r) => {
      if (active && r.ok) setRooms(r.data.filter((x) => x.status === "open"));
    });
    return () => {
      active = false;
    };
  }, [incidentId]);

  async function start() {
    setBusy(true);
    setErr(null);
    const r = await createRoomAction(`${t("videoIncidentPrefix")}${summary.slice(0, 60)}`, {
      linkedType: "incident",
      linkedId: incidentId,
    });
    setBusy(false);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    router.push(`/video?join=${r.data.id}`);
  }

  return (
    <div className="flex flex-col gap-2">
      {err && (
        <div className="text-[11px]" style={{ color: "var(--c-sev-1)" }}>
          {err}
        </div>
      )}
      {rooms.length > 0 ? (
        <div className="flex flex-col gap-1">
          {rooms.map((room) => (
            <Link
              key={room.id}
              href={`/video?join=${room.id}`}
              className="flex items-center justify-between rounded-md px-2 py-1 text-[12px]"
              style={{ background: "var(--c-bg-2)", color: "var(--c-fg-1)" }}
            >
              <span className="truncate">{room.name}</span>
              <span style={{ color: "var(--c-accent)" }}>{t("videoJoin")}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
          {t("videoNone")}
        </div>
      )}
      {canStart && (
        <button className="cmc-btn" disabled={busy} onClick={() => void start()}>
          {busy ? t("videoStarting") : t("videoStart")}
        </button>
      )}
    </div>
  );
}
