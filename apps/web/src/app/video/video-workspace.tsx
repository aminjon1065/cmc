"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import type { VideoRecording, VideoRoom } from "@cmc/contracts";
import {
  closeRoomAction,
  createRoomAction,
  listRecordingsAction,
  listRoomsAction,
  recordingDownloadAction,
  startRecordingAction,
  stopRecordingAction,
} from "./actions";

/** Loading fallback for the lazily-loaded conference surface. */
function ConferenceLoading() {
  const t = useTranslations("video");
  return (
    <div className="p-4 text-[12px]" style={{ color: "var(--c-fg-3)" }}>
      {t("loadingConference")}
    </div>
  );
}

// livekit-client touches browser-only APIs — load the live surface client-only.
const RoomStage = dynamic(
  () => import("./room-stage").then((m) => m.RoomStage),
  {
    ssr: false,
    loading: () => <ConferenceLoading />,
  },
);

type Joined = {
  token: string;
  serverUrl: string;
  roomName: string;
  roomId: string;
};
type Msg = { kind: "ok" | "err"; text: string } | null;

export function VideoWorkspace({
  initialRooms,
  canWrite,
  canManage,
  currentUserId,
  initialJoinRoomId,
}: {
  initialRooms: VideoRoom[];
  canWrite: boolean;
  canManage: boolean;
  currentUserId: string | null;
  initialJoinRoomId?: string;
}) {
  const t = useTranslations("video");
  const [rooms, setRooms] = useState<VideoRoom[]>(initialRooms);
  const [joined, setJoined] = useState<Joined | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  // Recording state for the room currently joined.
  const [recordings, setRecordings] = useState<VideoRecording[]>([]);
  const [activeRecId, setActiveRecId] = useState<string | null>(null);
  const [recMsg, setRecMsg] = useState<string | null>(null);

  async function refresh() {
    const r = await listRoomsAction();
    if (r.ok) setRooms(r.data);
  }

  async function create() {
    if (!newName.trim()) return;
    setBusy(true);
    setMsg(null);
    const r = await createRoomAction(newName);
    setBusy(false);
    if (!r.ok) {
      setMsg({ kind: "err", text: r.error });
      return;
    }
    setNewName("");
    await refresh();
  }

  async function close(id: string) {
    if (!confirm(t("confirmClose"))) return;
    setBusy(true);
    setMsg(null);
    const r = await closeRoomAction(id);
    setBusy(false);
    if (!r.ok) {
      setMsg({ kind: "err", text: r.error });
      return;
    }
    await refresh();
  }

  async function refreshRecordings(roomId: string) {
    const r = await listRecordingsAction(roomId);
    if (r.ok) {
      setRecordings(r.data);
      setActiveRecId(r.data.find((x) => x.status === "active")?.id ?? null);
    }
  }

  async function join(roomId: string) {
    setBusy(true);
    setMsg(null);
    setRecMsg(null);
    try {
      const res = await fetch("/api/video/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId }),
      });
      if (!res.ok) {
        setMsg({
          kind: "err",
          text:
            res.status === 403
              ? t("joinForbidden")
              : res.status === 409
                ? t("roomClosed")
                : t("joinTokenFailed"),
        });
        return;
      }
      const tok = (await res.json()) as {
        token: string;
        url: string;
        roomName: string;
        enabled: boolean;
      };
      if (!tok.enabled) {
        setMsg({
          kind: "err",
          text: t("notEnabled"),
        });
        return;
      }
      setJoined({
        token: tok.token,
        serverUrl: tok.url,
        roomName: tok.roomName,
        roomId,
      });
      void refreshRecordings(roomId);
    } catch {
      setMsg({ kind: "err", text: t("networkError") });
    } finally {
      setBusy(false);
    }
  }

  // Auto-join when arriving via /video?join=<id> (e.g. from an incident).
  useEffect(() => {
    if (initialJoinRoomId) void join(initialJoinRoomId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startRec() {
    if (!joined) return;
    setRecMsg(null);
    const r = await startRecordingAction(joined.roomId);
    if (!r.ok) {
      setRecMsg(r.error);
      return;
    }
    setActiveRecId(r.data.id);
    void refreshRecordings(joined.roomId);
  }

  async function stopRec() {
    if (!activeRecId || !joined) return;
    const r = await stopRecordingAction(activeRecId);
    if (!r.ok) {
      setRecMsg(r.error);
      return;
    }
    setActiveRecId(null);
    void refreshRecordings(joined.roomId);
  }

  async function download(recordingId: string) {
    const r = await recordingDownloadAction(recordingId);
    if (r.ok) window.open(r.data, "_blank", "noopener");
    else setRecMsg(r.error);
  }

  function leave() {
    setJoined(null);
    setRecordings([]);
    setActiveRecId(null);
    setRecMsg(null);
    void refresh();
  }

  if (joined) {
    const completed = recordings.filter((r) => r.status === "complete");
    return (
      <div className="flex flex-col gap-2 p-3" style={{ height: "calc(100vh - 116px)" }}>
        <div className="flex items-center gap-2">
          <span className="cmc-display text-[14px] font-semibold" style={{ color: "var(--c-fg-1)" }}>
            {t("inCall")}
          </span>
          {activeRecId && (
            <span
              className="flex items-center gap-1 text-[10px]"
              style={{ color: "var(--c-sev-1)" }}
              title={t("recordingInProgress")}
            >
              <span style={{ fontSize: 8 }}>●</span> REC
            </span>
          )}
          {recMsg && (
            <span className="text-[10px]" style={{ color: "var(--c-sev-1)" }}>
              {recMsg}
            </span>
          )}
          <div className="flex-1" />
          {canManage &&
            (activeRecId ? (
              <button className="cmc-btn" onClick={() => void stopRec()}>
                {t("stopRecording")}
              </button>
            ) : (
              <button className="cmc-btn" onClick={() => void startRec()}>
                {t("record")}
              </button>
            ))}
          {completed.length > 0 && (
            <button
              className="cmc-btn"
              title={t("downloadLatest")}
              onClick={() => void download(completed[0]!.id)}
            >
              ⬇ {t("recording")}
            </button>
          )}
          <button className="cmc-btn" onClick={leave}>
            {t("leave")}
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <RoomStage token={joined.token} serverUrl={joined.serverUrl} onLeave={leave} />
        </div>
      </div>
    );
  }

  const openRooms = rooms.filter((r) => r.status === "open");
  const closedRooms = rooms.filter((r) => r.status === "closed");

  return (
    <div className="flex flex-col gap-3 p-5" style={{ maxWidth: 720 }}>
      {msg && (
        <div
          className="rounded-md p-2.5 text-[12px]"
          style={{
            color: msg.kind === "ok" ? "var(--c-accent)" : "var(--c-sev-1)",
            background:
              msg.kind === "ok"
                ? "color-mix(in srgb, var(--c-accent) 10%, transparent)"
                : "var(--c-sev-1-soft)",
          }}
        >
          {msg.text}
        </div>
      )}

      {canWrite && (
        <div className="cmc-card flex items-center gap-2 p-3">
          <input
            className="cmc-input"
            style={{ flex: 1 }}
            placeholder={t("newRoomPlaceholder")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) void create();
            }}
          />
          <button
            className="cmc-btn"
            disabled={busy || !newName.trim()}
            onClick={() => void create()}
          >
            {busy ? "…" : t("createRoom")}
          </button>
        </div>
      )}

      <div className="cmc-card flex flex-col">
        <div
          className="px-3 py-2"
          style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
        >
          <span className="cmc-label">{t("rooms")}</span>
        </div>
        <div className="flex flex-col">
          {openRooms.length === 0 && (
            <div className="px-3 py-4 text-[12px]" style={{ color: "var(--c-fg-3)" }}>
              {canWrite ? t("noOpenRoomsCreate") : t("noOpenRooms")}
            </div>
          )}
          {openRooms.map((room) => (
            <div
              key={room.id}
              className="flex items-center gap-2 px-3 py-2"
              style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]" style={{ color: "var(--c-fg-1)" }}>
                  {room.name}
                </div>
                <div className="cmc-mono text-[9.5px]" style={{ color: "var(--c-fg-4)" }}>
                  {new Date(room.createdAt).toLocaleString()}
                </div>
              </div>
              <button
                className="cmc-btn"
                disabled={busy}
                onClick={() => void join(room.id)}
              >
                {t("join")}
              </button>
              {(canManage || room.createdBy === currentUserId) && (
                <button
                  className="cmc-btn"
                  style={{ color: "var(--c-sev-1)" }}
                  disabled={busy}
                  onClick={() => void close(room.id)}
                >
                  {t("close")}
                </button>
              )}
            </div>
          ))}
        </div>
        {closedRooms.length > 0 && (
          <div className="px-3 py-2">
            <div className="cmc-label mb-1">{t("closed")}</div>
            {closedRooms.slice(0, 10).map((room) => (
              <div
                key={room.id}
                className="truncate py-0.5 text-[11.5px]"
                style={{ color: "var(--c-fg-4)" }}
              >
                {room.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
