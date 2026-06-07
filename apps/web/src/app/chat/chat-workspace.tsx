"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FormattedDate } from "@/components/cmc/formatted-date";
import type { ChatChannel, ChatMessage } from "@cmc/contracts";
import {
  createChannelAction,
  deleteMessageAction,
  listMessagesAction,
  listRepliesAction,
  postMessageAction,
  toggleReactionAction,
} from "./actions";

const QUICK_EMOJIS = ["👍", "✅", "❤️", "🎉", "👀"];

type Msg = { kind: "ok" | "err"; text: string } | null;

export function ChatWorkspace({
  initialChannels,
  canWrite,
  canManage,
  currentUserId,
}: {
  initialChannels: ChatChannel[];
  canWrite: boolean;
  canManage: boolean;
  currentUserId: string | null;
}) {
  const t = useTranslations("chat");
  const [channels, setChannels] = useState<ChatChannel[]>(initialChannels);
  const [active, setActive] = useState<string | null>(
    initialChannels[0]?.id ?? null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [newName, setNewName] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [threadOf, setThreadOf] = useState<string | null>(null);
  const [replies, setReplies] = useState<ChatMessage[]>([]);
  const [replyBody, setReplyBody] = useState("");
  const activeRef = useRef<string | null>(active);
  activeRef.current = active;

  const loadMessages = useCallback(async (channelId: string) => {
    const res = await listMessagesAction(channelId);
    // Ignore late responses for a channel the user already switched away from.
    if (res.ok && activeRef.current === channelId) setMessages(res.data.messages);
  }, []);

  useEffect(() => {
    if (active) void loadMessages(active);
    else setMessages([]);
  }, [active, loadMessages]);

  // Poll the active channel for near-real-time updates (the realtime WS plane
  // exists server-side; browser polling avoids exposing the JWT — see ADR-0057).
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (!document.hidden) void loadMessages(active);
    }, 4000);
    return () => clearInterval(t);
  }, [active, loadMessages]);

  async function send() {
    if (!active || !body.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await postMessageAction(active, body);
    setBusy(false);
    if (!res.ok) return setMsg({ kind: "err", text: res.error });
    setBody("");
    void loadMessages(active);
  }

  async function react(m: ChatMessage, emoji: string) {
    const mine = m.reactions.find((r) => r.emoji === emoji)?.mine ?? false;
    const res = await toggleReactionAction(m.id, emoji, !mine);
    if (!res.ok) return setMsg({ kind: "err", text: res.error });
    const updated = res.data;
    setMessages((ms) => ms.map((x) => (x.id === updated.id ? updated : x)));
  }

  async function del(id: string) {
    if (!confirm(t("confirmDeleteMessage"))) return;
    const res = await deleteMessageAction(id);
    if (!res.ok) return setMsg({ kind: "err", text: res.error });
    if (active) void loadMessages(active);
    if (threadOf === id) setThreadOf(null);
  }

  async function openThread(id: string) {
    setThreadOf(id);
    setReplyBody("");
    const res = await listRepliesAction(id);
    if (res.ok) setReplies(res.data);
  }

  async function sendReply() {
    if (!active || !threadOf || !replyBody.trim()) return;
    setBusy(true);
    const res = await postMessageAction(active, replyBody, threadOf);
    setBusy(false);
    if (!res.ok) return setMsg({ kind: "err", text: res.error });
    setReplyBody("");
    const r = await listRepliesAction(threadOf);
    if (r.ok) setReplies(r.data);
    void loadMessages(active); // refresh replyCount
  }

  async function createChannel() {
    if (!newName.trim()) return;
    setBusy(true);
    const res = await createChannelAction(newName);
    setBusy(false);
    if (!res.ok) return setMsg({ kind: "err", text: res.error });
    setChannels((c) => [...c, res.data]);
    setActive(res.data.id);
    setNewName("");
    setShowNew(false);
  }

  function canDelete(m: ChatMessage): boolean {
    return canManage || (!!currentUserId && m.authorId === currentUserId);
  }
  function who(authorId: string | null): string {
    if (authorId && authorId === currentUserId) return t("you");
    if (authorId) return t("userPrefix", { id: authorId.slice(0, 8) });
    return "—";
  }

  const activeChannel = channels.find((c) => c.id === active) ?? null;

  return (
    <div className="flex" style={{ height: "calc(100vh - 52px)" }}>
      {/* Channels */}
      <div
        className="flex shrink-0 flex-col"
        style={{ width: 220, borderRight: "0.5px solid var(--c-line-2)" }}
      >
        <div
          className="flex items-center gap-2 px-3 py-2.5"
          style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
        >
          <span className="cmc-label">{t("channels")}</span>
          <div className="flex-1" />
          {canManage && (
            <button
              className="cmc-btn"
              style={{ padding: "1px 8px" }}
              onClick={() => setShowNew((s) => !s)}
            >
              +
            </button>
          )}
        </div>
        {showNew && (
          <div className="flex gap-1 px-2 py-2">
            <input
              className="cmc-input"
              style={{ flex: 1, padding: "2px 6px", fontSize: 12 }}
              autoFocus
              placeholder={t("channelNamePlaceholder")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createChannel()}
            />
            <button className="cmc-btn" style={{ padding: "1px 8px" }} onClick={createChannel}>
              {t("add")}
            </button>
          </div>
        )}
        <div className="flex-1 overflow-auto py-1">
          {channels.length === 0 ? (
            <div className="px-3 py-3 text-[11px]" style={{ color: "var(--c-fg-3)" }}>
              {t("noChannels")}
            </div>
          ) : (
            channels.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setActive(c.id);
                  setThreadOf(null);
                }}
                className="block w-full truncate px-3 py-1.5 text-left text-[12.5px]"
                style={{
                  background: c.id === active ? "var(--c-bg-3)" : "transparent",
                  color: c.id === active ? "var(--c-fg-1)" : "var(--c-fg-2)",
                  fontWeight: c.id === active ? 500 : 400,
                }}
              >
                # {c.name}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Stream */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex items-center gap-2 px-4 py-2.5"
          style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
        >
          <span className="cmc-display text-[14px] font-semibold" style={{ color: "var(--c-fg-1)" }}>
            {activeChannel ? `# ${activeChannel.name}` : t("selectChannel")}
          </span>
        </div>

        {msg && (
          <div
            className="mx-4 mt-2 rounded-md p-2 text-[11.5px]"
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

        <div className="flex flex-1 flex-col-reverse overflow-auto px-4 py-3">
          {/* column-reverse keeps the newest pinned to the bottom */}
          <div className="flex flex-col gap-2.5">
            {messages.length === 0 ? (
              <div className="text-[12px]" style={{ color: "var(--c-fg-3)" }}>
                {activeChannel ? t("noMessages") : ""}
              </div>
            ) : (
              messages.map((m) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  who={who(m.authorId)}
                  canWrite={canWrite}
                  canDelete={canDelete(m)}
                  onReact={(emoji) => react(m, emoji)}
                  onThread={() => openThread(m.id)}
                  onDelete={() => del(m.id)}
                />
              ))
            )}
          </div>
        </div>

        {canWrite && activeChannel && (
          <div
            className="flex items-end gap-2 px-4 py-3"
            style={{ borderTop: "0.5px solid var(--c-line-2)" }}
          >
            <textarea
              className="cmc-input"
              style={{ flex: 1, minHeight: 38, padding: "8px 10px" }}
              placeholder={t("messagePlaceholder", { channel: activeChannel.name })}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="cmc-btn" onClick={send} disabled={busy || !body.trim()}>
              {t("send")}
            </button>
          </div>
        )}
      </div>

      {/* Thread */}
      {threadOf && (
        <div
          className="flex shrink-0 flex-col"
          style={{ width: 300, borderLeft: "0.5px solid var(--c-line-2)" }}
        >
          <div
            className="flex items-center gap-2 px-3 py-2.5"
            style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
          >
            <span className="cmc-label">{t("thread")}</span>
            <div className="flex-1" />
            <button
              className="text-[12px]"
              style={{ color: "var(--c-fg-3)" }}
              onClick={() => setThreadOf(null)}
            >
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-auto px-3 py-2">
            {replies.length === 0 ? (
              <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
                {t("noReplies")}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {replies.map((r) => (
                  <div key={r.id}>
                    <div className="text-[10.5px]" style={{ color: "var(--c-fg-3)" }}>
                      {who(r.authorId)}
                    </div>
                    <div className="text-[12px]" style={{ color: "var(--c-fg-1)" }}>
                      {r.body}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {canWrite && (
            <div className="flex gap-1 px-3 py-2" style={{ borderTop: "0.5px solid var(--c-line-2)" }}>
              <input
                className="cmc-input"
                style={{ flex: 1, padding: "4px 8px", fontSize: 12 }}
                placeholder={t("replyPlaceholder")}
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendReply()}
              />
              <button className="cmc-btn" style={{ padding: "2px 8px" }} onClick={sendReply} disabled={busy}>
                {t("send")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageRow({
  m,
  who,
  canWrite,
  canDelete,
  onReact,
  onThread,
  onDelete,
}: {
  m: ChatMessage;
  who: string;
  canWrite: boolean;
  canDelete: boolean;
  onReact: (emoji: string) => void;
  onThread: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("chat");
  const [showPicker, setShowPicker] = useState(false);
  return (
    <div className="group flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[11.5px] font-medium" style={{ color: "var(--c-fg-2)" }}>
          {who}
        </span>
        <span className="cmc-mono text-[9.5px]" style={{ color: "var(--c-fg-4)" }}>
          <FormattedDate value={m.createdAt} preset="time" />
        </span>
        {m.edited && (
          <span className="text-[9.5px]" style={{ color: "var(--c-fg-4)" }}>
            {t("edited")}
          </span>
        )}
        <div className="flex-1" />
        {canWrite && (
          <button
            className="text-[11px] opacity-0 group-hover:opacity-100"
            style={{ color: "var(--c-fg-3)" }}
            onClick={() => setShowPicker((s) => !s)}
            title={t("react")}
          >
            ☺+
          </button>
        )}
        {canDelete && (
          <button
            className="text-[11px] opacity-0 group-hover:opacity-100"
            style={{ color: "var(--c-fg-4)" }}
            onClick={onDelete}
            title={t("delete")}
          >
            ✕
          </button>
        )}
      </div>
      <div className="whitespace-pre-wrap text-[12.5px]" style={{ color: "var(--c-fg-1)" }}>
        {m.body}
      </div>
      {showPicker && (
        <div className="flex gap-1">
          {QUICK_EMOJIS.map((e) => (
            <button
              key={e}
              className="rounded px-1.5 py-0.5 text-[13px]"
              style={{ background: "var(--c-bg-2)" }}
              onClick={() => {
                onReact(e);
                setShowPicker(false);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {m.reactions.map((r) => (
          <button
            key={r.emoji}
            onClick={() => onReact(r.emoji)}
            disabled={!canWrite}
            className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px]"
            style={{
              background: r.mine
                ? "color-mix(in srgb, var(--c-accent) 16%, transparent)"
                : "var(--c-bg-2)",
              border: r.mine
                ? "0.5px solid var(--c-accent-line)"
                : "0.5px solid var(--c-line-2)",
            }}
          >
            <span>{r.emoji}</span>
            <span style={{ color: "var(--c-fg-3)" }}>{r.count}</span>
          </button>
        ))}
        {m.replyCount > 0 ? (
          <button
            className="text-[10.5px] hover:underline"
            style={{ color: "var(--c-accent)" }}
            onClick={onThread}
          >
            💬{" "}
            {m.replyCount === 1
              ? t("replyCountOne", { count: m.replyCount })
              : t("replyCountOther", { count: m.replyCount })}
          </button>
        ) : (
          canWrite && (
            <button
              className="text-[10.5px] opacity-0 hover:underline group-hover:opacity-100"
              style={{ color: "var(--c-fg-3)" }}
              onClick={onThread}
            >
              {t("replyInThread")}
            </button>
          )
        )}
      </div>
    </div>
  );
}
