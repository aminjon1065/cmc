"use client";

import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import type { CollabTicketResponse } from "@cmc/contracts";
import { EditorToolbar } from "./page-editor";
import { encodeSelectionAnchor } from "./comment-anchor";
import {
  CommentHighlight,
  commentHighlightKey,
  type AnchoredComment,
} from "./comment-highlight";

export type CollabStatus = "connecting" | "live" | "failed";

const CURSOR_COLORS = [
  "#2f81f7",
  "#1f883d",
  "#bf3989",
  "#9a6700",
  "#8250df",
  "#cf222e",
  "#0969da",
  "#bc4c00",
];
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CURSOR_COLORS[h % CURSOR_COLORS.length]!;
}

type Conn = {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  userName: string;
  userColor: string;
};

/**
 * Collaborative wiki-body editor (P4.1b/c / ADR-0060). Binds TipTap to a Yjs
 * doc synced over the gated Hocuspocus WS, authenticated with a single-use BFF
 * ticket (never the raw JWT). Adds (P4.1c): **offline reconcile** via an
 * IndexedDB persistence provider (edits made offline survive a reload and merge
 * on reconnect) and **anchored comments** (highlight decorations + a floating
 * "Comment" button on selection). Best-effort: on failure the parent falls back
 * to the manual save-based editor.
 */
export function CollabPageEditor({
  pageId,
  anchoredComments,
  onStatusChange,
  onPeers,
  onCreateAnchored,
  onActivateComment,
}: {
  pageId: string;
  anchoredComments: AnchoredComment[];
  onStatusChange: (s: CollabStatus) => void;
  onPeers?: (n: number) => void;
  onCreateAnchored: (
    anchor: string,
    anchorText: string,
    body: string,
  ) => void | Promise<void>;
  onActivateComment: (id: string) => void;
}) {
  const [conn, setConn] = useState<Conn | null>(null);
  const [online, setOnline] = useState(true);
  const statusCb = useRef(onStatusChange);
  statusCb.current = onStatusChange;
  const peersCb = useRef(onPeers);
  peersCb.current = onPeers;

  useEffect(() => {
    let cancelled = false;
    let lived = false;
    let prov: HocuspocusProvider | null = null;
    let idb: IndexeddbPersistence | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ydoc = new Y.Doc();

    const fetchTicket = async (): Promise<CollabTicketResponse | null> => {
      try {
        const res = await fetch("/api/collab/ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pageId }),
        });
        if (!res.ok) return null;
        return (await res.json()) as CollabTicketResponse;
      } catch {
        return null;
      }
    };

    statusCb.current("connecting");
    void (async () => {
      const meta = await fetchTicket();
      if (cancelled) {
        ydoc.destroy();
        return;
      }
      if (!meta || !meta.enabled) {
        statusCb.current("failed");
        ydoc.destroy();
        return;
      }
      // Offline durability: edits persist locally and reconcile on reconnect.
      idb = new IndexeddbPersistence(meta.docName, ydoc);
      let first: string | null = meta.ticket;
      const provider = new HocuspocusProvider({
        url: meta.wsUrl,
        name: meta.docName,
        document: ydoc,
        token: async () => {
          if (first) {
            const t = first;
            first = null;
            return t;
          }
          return (await fetchTicket())?.ticket ?? "";
        },
        onStatus: ({ status }: { status: string }) => {
          if (!cancelled) setOnline(status === "connected");
        },
        onAuthenticationFailed: () => {
          if (!cancelled && !lived) statusCb.current("failed");
        },
        onSynced: () => {
          if (cancelled) return;
          lived = true;
          if (timer) clearTimeout(timer);
          statusCb.current("live");
        },
        onAwarenessUpdate: ({ states }: { states: unknown[] }) => {
          if (!cancelled) peersCb.current?.(states.length);
        },
      });
      timer = setTimeout(() => {
        if (!cancelled && !lived) statusCb.current("failed");
      }, 6000);
      if (cancelled) {
        provider.destroy();
        void idb.destroy();
        ydoc.destroy();
        return;
      }
      prov = provider;
      setConn({
        provider,
        ydoc,
        userName: meta.user.name,
        userColor: colorFor(meta.user.id),
      });
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      prov?.destroy();
      if (idb) void idb.destroy();
      ydoc.destroy();
    };
  }, [pageId]);

  if (!conn) {
    return (
      <div className="p-4 text-[12px]" style={{ color: "var(--c-fg-3)" }}>
        Connecting to live collaboration…
      </div>
    );
  }
  return (
    <CollabEditorInner
      conn={conn}
      online={online}
      anchoredComments={anchoredComments}
      onCreateAnchored={onCreateAnchored}
      onActivateComment={onActivateComment}
    />
  );
}

/** Mounted only once a provider exists, so `useEditor` always has its deps. */
function CollabEditorInner({
  conn,
  online,
  anchoredComments,
  onCreateAnchored,
  onActivateComment,
}: {
  conn: Conn;
  online: boolean;
  anchoredComments: AnchoredComment[];
  onCreateAnchored: (
    anchor: string,
    anchorText: string,
    body: string,
  ) => void | Promise<void>;
  onActivateComment: (id: string) => void;
}) {
  const [bubble, setBubble] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const activateRef = useRef(onActivateComment);
  activateRef.current = onActivateComment;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: conn.ydoc, field: "default" }),
      CollaborationCursor.configure({
        provider: conn.provider,
        user: { name: conn.userName, color: conn.userColor },
      }),
      CommentHighlight.configure({
        onActivate: (id: string) => activateRef.current(id),
      }),
    ],
    editable: true,
    immediatelyRender: false,
    editorProps: { attributes: { class: "wiki-prose focus:outline-none" } },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      if (from === to) {
        setBubble(null);
        setComposing(false);
        return;
      }
      try {
        const start = editor.view.coordsAtPos(from);
        setBubble({ left: start.left, top: start.top });
      } catch {
        setBubble(null);
      }
    },
  });

  // Push the anchored-comment list into the highlight plugin when it changes.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(commentHighlightKey, {
        comments: anchoredComments,
      }),
    );
  }, [editor, anchoredComments]);

  async function submitComment() {
    if (!editor || !draft.trim()) return;
    const { from, to } = editor.state.selection;
    const anchor = encodeSelectionAnchor(editor.state);
    if (!anchor) {
      setComposing(false);
      setBubble(null);
      return;
    }
    const text = editor.state.doc.textBetween(from, to, " ").slice(0, 2000);
    await onCreateAnchored(anchor, text, draft.trim());
    setDraft("");
    setComposing(false);
    setBubble(null);
  }

  if (!editor) {
    return (
      <div className="p-4 text-[12px]" style={{ color: "var(--c-fg-3)" }}>
        Loading editor…
      </div>
    );
  }
  return (
    <div className="relative flex flex-col">
      {!online && (
        <div
          className="px-3 py-1 text-[11px]"
          style={{
            color: "var(--c-sev-2)",
            background: "var(--c-sev-2-soft, color-mix(in srgb, orange 12%, transparent))",
          }}
          title="Disconnected — your edits are saved locally and will sync on reconnect"
        >
          ● Offline — changes saved locally
        </div>
      )}
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />
      {bubble && (
        <div
          style={{
            position: "fixed",
            left: bubble.left,
            top: bubble.top - 40,
            zIndex: 50,
          }}
        >
          {composing ? (
            <div className="cmc-card flex items-center gap-1 p-1">
              <input
                className="cmc-input"
                style={{ padding: "2px 6px", fontSize: 12, width: 200 }}
                autoFocus
                placeholder="Comment on selection…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitComment();
                  if (e.key === "Escape") {
                    setComposing(false);
                    setBubble(null);
                  }
                }}
              />
              <button
                className="cmc-btn"
                style={{ padding: "1px 8px" }}
                disabled={!draft.trim()}
                onClick={() => void submitComment()}
              >
                Send
              </button>
            </div>
          ) : (
            <button
              className="cmc-btn"
              style={{ padding: "2px 10px" }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setComposing(true)}
            >
              💬 Comment
            </button>
          )}
        </div>
      )}
    </div>
  );
}
