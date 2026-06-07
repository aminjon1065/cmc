"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FormattedDate } from "@/components/cmc/formatted-date";
import type {
  ProseMirrorDoc,
  WikiComment,
  WikiPage,
  WikiPageSummary,
  WikiPageVersion,
} from "@cmc/contracts";
import {
  createCommentAction,
  createPageAction,
  deleteCommentAction,
  deletePageAction,
  getPageAction,
  listCommentsAction,
  listVersionsAction,
  restoreVersionAction,
  savePageAction,
} from "../actions";
import { PageEditor } from "./page-editor";
import { CollabPageEditor, type CollabStatus } from "./collab-page-editor";

const EMPTY_DOC: ProseMirrorDoc = { type: "doc", content: [] };

type Msg = { kind: "ok" | "err"; text: string } | null;

export function WikiWorkspace({
  spaceId,
  initialPages,
  initialPageId,
  canWrite,
  canManage,
  currentUserId,
}: {
  spaceId: string;
  initialPages: WikiPageSummary[];
  initialPageId: string | null;
  canWrite: boolean;
  canManage: boolean;
  currentUserId: string | null;
}) {
  const t = useTranslations("wiki");
  const [pages, setPages] = useState<WikiPageSummary[]>(initialPages);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialPageId ?? initialPages[0]?.id ?? null,
  );
  const [page, setPage] = useState<WikiPage | null>(null);
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState(false);
  // Collaboration state for the page being edited. `null` = not attempting;
  // "failed" = fall back to the manual save-based editor.
  const [collabStatus, setCollabStatus] = useState<CollabStatus | null>(null);
  const [peers, setPeers] = useState(0);
  // The anchored comment a highlight click jumped to (flashed in the panel).
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [versions, setVersions] = useState<WikiPageVersion[]>([]);
  const [comments, setComments] = useState<WikiComment[]>([]);
  const [tab, setTab] = useState<"versions" | "comments">("comments");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [newChildOf, setNewChildOf] = useState<string | "root" | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const contentRef = useRef<ProseMirrorDoc>(EMPTY_DOC);

  const refreshSide = useCallback(async (id: string) => {
    const [v, c] = await Promise.all([
      listVersionsAction(id),
      listCommentsAction(id),
    ]);
    if (v.ok) setVersions(v.data);
    if (c.ok) setComments(c.data);
  }, []);

  const loadPage = useCallback(
    async (id: string) => {
      setBusy(true);
      setMsg(null);
      setEditing(false);
      setCollabStatus(null);
      const res = await getPageAction(id);
      setBusy(false);
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setSelectedId(id);
      setPage(res.data);
      setTitle(res.data.title);
      contentRef.current = res.data.content;
      setLoadKey((k) => k + 1);
      void refreshSide(id);
    },
    [refreshSide],
  );

  // Load the initially-selected page once on mount.
  useEffect(() => {
    if (selectedId) void loadPage(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createPage(parentId: string | null) {
    if (!newTitle.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await createPageAction(spaceId, newTitle, parentId);
    setBusy(false);
    setNewChildOf(null);
    setNewTitle("");
    if (!res.ok) {
      setMsg({ kind: "err", text: res.error });
      return;
    }
    setPages(res.data.pages);
    await loadPage(res.data.id);
    startEdit();
  }

  async function save() {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    const res = await savePageAction(selectedId, {
      title: title.trim() || t("untitled"),
      content: contentRef.current,
    });
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "err", text: res.error });
      return;
    }
    setPage(res.data);
    setEditing(false);
    setPages((ps) =>
      ps.map((p) =>
        p.id === res.data.id
          ? {
              ...p,
              title: res.data.title,
              currentVersionNo: res.data.currentVersionNo,
              updatedAt: res.data.updatedAt,
            }
          : p,
      ),
    );
    setMsg({
      kind: "ok",
      text: t("saved", { version: res.data.currentVersionNo }),
    });
    void refreshSide(res.data.id);
  }

  async function remove() {
    if (!selectedId) return;
    if (!confirm(t("confirmDeletePage"))) return;
    setBusy(true);
    setMsg(null);
    const res = await deletePageAction(spaceId, selectedId);
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "err", text: res.error });
      return;
    }
    setPages(res.data.pages);
    setSelectedId(null);
    setPage(null);
    setVersions([]);
    setComments([]);
  }

  async function restore(versionNo: number) {
    if (!selectedId) return;
    if (!confirm(t("confirmRestore", { versionNo }))) return;
    setBusy(true);
    setMsg(null);
    const res = await restoreVersionAction(selectedId, versionNo);
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "err", text: res.error });
      return;
    }
    setPage(res.data);
    setTitle(res.data.title);
    contentRef.current = res.data.content;
    setLoadKey((k) => k + 1);
    setMsg({
      kind: "ok",
      text: t("restored", { version: res.data.currentVersionNo }),
    });
    void refreshSide(res.data.id);
  }

  // Enter edit mode and attempt live collaboration (falls back to manual save
  // if the feature is off or the WS can't be reached — see CollabPageEditor).
  function startEdit() {
    setMsg(null);
    setPeers(0);
    setCollabStatus("connecting");
    setEditing(true);
  }

  // Manual-fallback cancel: discard local edits and return to view.
  function cancelEdit() {
    if (!page) return;
    setEditing(false);
    setCollabStatus(null);
    setTitle(page.title);
    contentRef.current = page.content;
    setLoadKey((k) => k + 1);
  }

  // Exit collaborative editing. The body is already persisted server-side by
  // Hocuspocus; only a title rename needs an explicit (title-only) write that
  // leaves the collaborative content untouched.
  async function doneEditing() {
    if (!selectedId || !page) return;
    const newTitle = title.trim() || t("untitled");
    if (newTitle !== page.title) {
      setBusy(true);
      const res = await savePageAction(selectedId, { title: newTitle });
      setBusy(false);
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
    }
    setCollabStatus(null);
    await loadPage(selectedId);
  }

  // Live collaboration is on when editing and the connection hasn't failed.
  const collabMode =
    editing && collabStatus !== null && collabStatus !== "failed";

  // Anchored comments (have a Yjs position) → rendered as editor highlights.
  const anchoredComments = useMemo(
    () =>
      comments
        .filter((c) => c.anchor)
        .map((c) => ({ id: c.id, anchor: c.anchor! })),
    [comments],
  );

  // Create an anchored comment from a selection in the collab editor.
  async function createAnchored(
    anchor: string,
    anchorText: string,
    body: string,
  ) {
    if (!selectedId) return;
    const res = await createCommentAction(selectedId, body, null, {
      anchor,
      anchorText,
    });
    if (!res.ok) {
      setMsg({ kind: "err", text: res.error });
      return;
    }
    setTab("comments");
    await refreshSide(selectedId);
  }

  return (
    <div className="flex gap-3 p-5" style={{ minHeight: 560 }}>
      {/* Tree */}
      <div
        className="cmc-card flex flex-col"
        style={{ width: 234, maxHeight: 620 }}
      >
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
        >
          <span className="cmc-label">{t("pages")}</span>
          <div className="flex-1" />
          {canWrite && (
            <button
              className="cmc-btn"
              style={{ padding: "1px 8px" }}
              onClick={() => {
                setNewChildOf("root");
                setNewTitle("");
              }}
            >
              {t("newPage")}
            </button>
          )}
        </div>
        <div className="flex-1 overflow-auto py-1">
          {newChildOf === "root" && (
            <NewRow
              value={newTitle}
              onChange={setNewTitle}
              onConfirm={() => createPage(null)}
              onCancel={() => setNewChildOf(null)}
              indent={0}
            />
          )}
          {pages.length === 0 && newChildOf !== "root" ? (
            <div
              className="px-3 py-3 text-[11px]"
              style={{ color: "var(--c-fg-3)" }}
            >
              {t("noPages")}
            </div>
          ) : (
            pages.map((p) => (
              <div key={p.id}>
                <div
                  className="group flex items-center gap-1 px-2 py-1 text-[12px]"
                  style={{
                    paddingLeft: 10 + p.depth * 14,
                    background:
                      p.id === selectedId ? "var(--c-bg-3)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <button
                    className="min-w-0 flex-1 truncate text-left"
                    style={{
                      color:
                        p.id === selectedId
                          ? "var(--c-fg-1)"
                          : "var(--c-fg-2)",
                      fontWeight: p.id === selectedId ? 500 : 400,
                    }}
                    onClick={() => loadPage(p.id)}
                    title={p.title}
                  >
                    {p.title}
                  </button>
                  {canWrite && (
                    <button
                      className="opacity-0 group-hover:opacity-100"
                      style={{ color: "var(--c-fg-3)", fontSize: 13 }}
                      title={t("addSubPage")}
                      onClick={() => {
                        setNewChildOf(p.id);
                        setNewTitle("");
                      }}
                    >
                      +
                    </button>
                  )}
                </div>
                {newChildOf === p.id && (
                  <NewRow
                    value={newTitle}
                    onChange={setNewTitle}
                    onConfirm={() => createPage(p.id)}
                    onCancel={() => setNewChildOf(null)}
                    indent={p.depth + 1}
                  />
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex flex-1 flex-col gap-3">
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

        {!selectedId || !page ? (
          <div className="cmc-card flex flex-1 items-center justify-center">
            <span className="text-[12px]" style={{ color: "var(--c-fg-3)" }}>
              {busy ? t("loading") : t("selectOrCreate")}
            </span>
          </div>
        ) : (
          <div className="cmc-card flex flex-1 flex-col overflow-hidden">
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
            >
              {editing ? (
                <input
                  className="cmc-input"
                  style={{ flex: 1, fontWeight: 600 }}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("pageTitlePlaceholder")}
                />
              ) : (
                <span
                  className="cmc-display flex-1 truncate text-[15px] font-semibold"
                  style={{ color: "var(--c-fg-1)" }}
                >
                  {page.title}
                </span>
              )}
              <span
                className="cmc-mono text-[10px]"
                style={{ color: "var(--c-fg-4)" }}
              >
                v{page.currentVersionNo}
              </span>
              {editing && collabMode && (
                <CollabBadge status={collabStatus} peers={peers} />
              )}
              {canWrite &&
                (editing ? (
                  collabMode ? (
                    <button
                      className="cmc-btn"
                      onClick={doneEditing}
                      disabled={busy}
                    >
                      {busy ? "…" : t("done")}
                    </button>
                  ) : (
                    <>
                      <button
                        className="cmc-btn"
                        onClick={save}
                        disabled={busy}
                      >
                        {busy ? t("saving") : t("save")}
                      </button>
                      <button
                        className="cmc-btn"
                        disabled={busy}
                        onClick={cancelEdit}
                      >
                        {t("cancel")}
                      </button>
                    </>
                  )
                ) : (
                  <>
                    <button className="cmc-btn" onClick={startEdit}>
                      {t("edit")}
                    </button>
                    <button
                      className="cmc-btn"
                      style={{ color: "var(--c-sev-1)" }}
                      onClick={remove}
                      disabled={busy}
                    >
                      {t("delete")}
                    </button>
                  </>
                ))}
            </div>
            <div className="flex-1 overflow-auto">
              {collabMode ? (
                <CollabPageEditor
                  key={`collab-${selectedId}-${loadKey}`}
                  pageId={selectedId}
                  anchoredComments={anchoredComments}
                  onStatusChange={setCollabStatus}
                  onPeers={setPeers}
                  onCreateAnchored={createAnchored}
                  onActivateComment={(id) => {
                    setTab("comments");
                    setActiveCommentId(id);
                  }}
                />
              ) : (
                <PageEditor
                  key={loadKey}
                  content={contentRef.current}
                  editable={editing}
                  onChange={(doc) => {
                    contentRef.current = doc;
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Versions / comments */}
      <div className="cmc-card flex flex-col" style={{ width: 290, maxHeight: 620 }}>
        <div
          className="flex items-center gap-1 px-2 py-2"
          style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
        >
          <TabBtn active={tab === "comments"} onClick={() => setTab("comments")}>
            {t("comments")}
          </TabBtn>
          <TabBtn active={tab === "versions"} onClick={() => setTab("versions")}>
            {t("history")}
          </TabBtn>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {!selectedId ? (
            <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
              {t("noPageSelected")}
            </div>
          ) : tab === "versions" ? (
            <VersionList
              versions={versions}
              canWrite={canWrite}
              onRestore={restore}
            />
          ) : (
            <CommentPanel
              pageId={selectedId}
              comments={comments}
              canWrite={canWrite}
              canManage={canManage}
              currentUserId={currentUserId}
              activeCommentId={activeCommentId}
              onChanged={() => refreshSide(selectedId)}
              setMsg={setMsg}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CollabBadge({
  status,
  peers,
}: {
  status: CollabStatus | null;
  peers: number;
}) {
  const t = useTranslations("wiki");
  if (status === "connecting") {
    return (
      <span className="text-[10px]" style={{ color: "var(--c-fg-4)" }}>
        {t("connecting")}
      </span>
    );
  }
  if (status === "live") {
    return (
      <span
        className="flex items-center gap-1 text-[10px]"
        style={{ color: "var(--c-accent)" }}
        title={t("liveTooltip")}
      >
        <span style={{ fontSize: 8 }}>●</span>
        {peers > 1 ? t("liveEditing", { count: peers }) : t("live")}
      </span>
    );
  }
  return null;
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded px-2 py-0.5 text-[11px]"
      style={{
        color: active ? "var(--c-fg-1)" : "var(--c-fg-3)",
        background: active ? "var(--c-bg-3)" : "transparent",
        fontWeight: active ? 500 : 400,
      }}
    >
      {children}
    </button>
  );
}

function NewRow({
  value,
  onChange,
  onConfirm,
  onCancel,
  indent,
}: {
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  indent: number;
}) {
  const t = useTranslations("wiki");
  return (
    <div
      className="flex items-center gap-1 py-1 pr-2"
      style={{ paddingLeft: 10 + indent * 14 }}
    >
      <input
        className="cmc-input"
        style={{ flex: 1, padding: "1px 6px", fontSize: 12 }}
        autoFocus
        placeholder={t("pageTitlePlaceholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm();
          if (e.key === "Escape") onCancel();
        }}
      />
      <button
        className="text-[12px]"
        style={{ color: "var(--c-accent)" }}
        onClick={onConfirm}
      >
        ✓
      </button>
      <button
        className="text-[12px]"
        style={{ color: "var(--c-fg-3)" }}
        onClick={onCancel}
      >
        ✕
      </button>
    </div>
  );
}

function VersionList({
  versions,
  canWrite,
  onRestore,
}: {
  versions: WikiPageVersion[];
  canWrite: boolean;
  onRestore: (v: number) => void;
}) {
  const t = useTranslations("wiki");
  if (versions.length === 0) {
    return (
      <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
        {t("noVersions")}
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {versions.map((v) => (
        <li
          key={v.versionNo}
          className="flex items-center gap-2 rounded-md px-2 py-1.5"
          style={{ background: "var(--c-bg-2)" }}
        >
          <span
            className="cmc-mono text-[11px]"
            style={{ color: v.isCurrent ? "var(--c-accent)" : "var(--c-fg-2)" }}
          >
            v{v.versionNo}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11.5px]" style={{ color: "var(--c-fg-2)" }}>
              {v.title}
            </div>
            <div className="cmc-mono text-[9.5px]" style={{ color: "var(--c-fg-4)" }}>
              <FormattedDate value={v.createdAt} />
            </div>
          </div>
          {v.isCurrent ? (
            <span className="text-[10px]" style={{ color: "var(--c-fg-4)" }}>
              {t("current")}
            </span>
          ) : (
            canWrite && (
              <button
                className="text-[10.5px] hover:underline"
                style={{ color: "var(--c-accent)" }}
                onClick={() => onRestore(v.versionNo)}
              >
                {t("restore")}
              </button>
            )
          )}
        </li>
      ))}
    </ul>
  );
}

function CommentPanel({
  pageId,
  comments,
  canWrite,
  canManage,
  currentUserId,
  activeCommentId,
  onChanged,
  setMsg,
}: {
  pageId: string;
  comments: WikiComment[];
  canWrite: boolean;
  canManage: boolean;
  currentUserId: string | null;
  activeCommentId: string | null;
  onChanged: () => void;
  setMsg: (m: Msg) => void;
}) {
  const t = useTranslations("wiki");
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [busy, setBusy] = useState(false);

  const { roots, childrenOf } = useMemo(() => {
    const childrenOf = new Map<string, WikiComment[]>();
    const roots: WikiComment[] = [];
    for (const c of comments) {
      if (c.parentId) {
        const arr = childrenOf.get(c.parentId) ?? [];
        arr.push(c);
        childrenOf.set(c.parentId, arr);
      } else {
        roots.push(c);
      }
    }
    return { roots, childrenOf };
  }, [comments]);

  async function add(text: string, parentId: string | null) {
    setBusy(true);
    setMsg(null);
    const res = await createCommentAction(pageId, text, parentId);
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "err", text: res.error });
      return;
    }
    if (parentId) {
      setReplyTo(null);
      setReplyBody("");
    } else {
      setBody("");
    }
    onChanged();
  }

  async function del(id: string) {
    setBusy(true);
    setMsg(null);
    const res = await deleteCommentAction(id);
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "err", text: res.error });
      return;
    }
    onChanged();
  }

  function canDelete(c: WikiComment): boolean {
    return canManage || (!!currentUserId && c.authorId === currentUserId);
  }

  function who(c: WikiComment): string {
    if (c.authorId && c.authorId === currentUserId) return t("you");
    if (c.authorId) return t("userPrefix", { id: c.authorId.slice(0, 8) });
    return t("unknown");
  }

  function Item({ c, depth }: { c: WikiComment; depth: number }) {
    const kids = childrenOf.get(c.id) ?? [];
    const isActive = c.id === activeCommentId;
    return (
      <div style={{ marginLeft: depth * 12 }}>
        <div
          className="rounded-md px-2 py-1.5"
          style={{
            background: isActive
              ? "color-mix(in srgb, var(--c-accent) 14%, transparent)"
              : "var(--c-bg-2)",
            border: isActive ? "0.5px solid var(--c-accent)" : undefined,
          }}
        >
          {c.anchor && c.anchorText && (
            <div
              className="mb-1 truncate border-l-2 pl-1.5 text-[10px] italic"
              style={{ borderColor: "var(--c-accent)", color: "var(--c-fg-3)" }}
              title={c.anchorText}
            >
              📌 “{c.anchorText}”
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] font-medium" style={{ color: "var(--c-fg-2)" }}>
              {who(c)}
            </span>
            <span className="cmc-mono text-[9px]" style={{ color: "var(--c-fg-4)" }}>
              <FormattedDate value={c.createdAt} />
            </span>
            <div className="flex-1" />
            {canDelete(c) && (
              <button
                className="text-[11px]"
                style={{ color: "var(--c-fg-4)" }}
                title="Delete"
                onClick={() => del(c.id)}
                disabled={busy}
              >
                ✕
              </button>
            )}
          </div>
          <div
            className="mt-0.5 whitespace-pre-wrap text-[11.5px]"
            style={{ color: "var(--c-fg-1)" }}
          >
            {c.body}
          </div>
          {canWrite && depth === 0 && (
            <button
              className="mt-1 text-[10px] hover:underline"
              style={{ color: "var(--c-fg-3)" }}
              onClick={() => {
                setReplyTo(replyTo === c.id ? null : c.id);
                setReplyBody("");
              }}
            >
              {t("reply")}
            </button>
          )}
        </div>
        {replyTo === c.id && (
          <div className="mt-1 flex gap-1" style={{ marginLeft: 12 }}>
            <input
              className="cmc-input"
              style={{ flex: 1, padding: "2px 6px", fontSize: 11 }}
              autoFocus
              placeholder={t("replyPlaceholder")}
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" && replyBody.trim() && add(replyBody, c.id)
              }
            />
            <button
              className="cmc-btn"
              style={{ padding: "1px 8px" }}
              disabled={busy || !replyBody.trim()}
              onClick={() => add(replyBody, c.id)}
            >
              {t("send")}
            </button>
          </div>
        )}
        {kids.length > 0 && (
          <div className="mt-1 flex flex-col gap-1">
            {kids.map((k) => (
              <Item key={k.id} c={k} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {canWrite && (
        <div className="flex flex-col gap-1">
          <textarea
            className="cmc-input"
            style={{ minHeight: 52, padding: "6px 8px", fontSize: 11.5 }}
            placeholder={t("addComment")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex">
            <div className="flex-1" />
            <button
              className="cmc-btn"
              disabled={busy || !body.trim()}
              onClick={() => add(body, null)}
            >
              {t("comment")}
            </button>
          </div>
        </div>
      )}
      {roots.length === 0 ? (
        <div className="text-[11px]" style={{ color: "var(--c-fg-3)" }}>
          {t("noComments")}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {roots.map((c) => (
            <Item key={c.id} c={c} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}
