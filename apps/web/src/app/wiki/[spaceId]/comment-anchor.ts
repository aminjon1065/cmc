import * as Y from "yjs";
import {
  ySyncPluginKey,
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "y-prosemirror";
import type { EditorState } from "@tiptap/pm/state";

/**
 * Anchored-comment positions (P4.1c / ADR-0060). A comment is pinned to a range
 * via two Yjs **relative positions** (resolved through the y-prosemirror binding
 * that backs TipTap `Collaboration`). Relative positions auto-rebase as the doc
 * is edited, so the highlight stays on the same words. We store them as a small
 * JSON of base64-encoded `Y.encodeRelativePosition` blobs in `wiki_comments.anchor`.
 */

// Derive the exact y-prosemirror parameter types from its own signatures so we
// never hand-roll `any` for the binding mapping / Yjs type.
type YType = Parameters<typeof absolutePositionToRelativePosition>[1];
type Mapping = Parameters<typeof absolutePositionToRelativePosition>[2];
type YSyncState = { type: YType; binding: { mapping: Mapping } | null; doc: Y.Doc };

function ysync(state: EditorState): YSyncState | undefined {
  return ySyncPluginKey.getState(state) as YSyncState | undefined;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

/**
 * Encode the current non-empty selection as an anchor, or null if there's no
 * collaborative binding / no selection. The result is opaque to the backend.
 */
export function encodeSelectionAnchor(state: EditorState): string | null {
  const ys = ysync(state);
  if (!ys || !ys.binding) return null;
  const { from, to } = state.selection;
  if (from === to) return null;
  const relFrom = absolutePositionToRelativePosition(
    from,
    ys.type,
    ys.binding.mapping,
  );
  const relTo = absolutePositionToRelativePosition(to, ys.type, ys.binding.mapping);
  return JSON.stringify({
    from: bytesToB64(Y.encodeRelativePosition(relFrom)),
    to: bytesToB64(Y.encodeRelativePosition(relTo)),
  });
}

/** Resolve an anchor against the current doc → absolute range, or null if gone. */
export function resolveAnchor(
  state: EditorState,
  anchor: string,
): { from: number; to: number } | null {
  const ys = ysync(state);
  if (!ys || !ys.binding) return null;
  let parsed: { from: string; to: string };
  try {
    parsed = JSON.parse(anchor) as { from: string; to: string };
  } catch {
    return null;
  }
  try {
    const relFrom = Y.decodeRelativePosition(b64ToBytes(parsed.from));
    const relTo = Y.decodeRelativePosition(b64ToBytes(parsed.to));
    const from = relativePositionToAbsolutePosition(
      ys.doc,
      ys.type,
      relFrom,
      ys.binding.mapping,
    );
    const to = relativePositionToAbsolutePosition(
      ys.doc,
      ys.type,
      relTo,
      ys.binding.mapping,
    );
    if (from == null || to == null || from === to) return null;
    return { from: Math.min(from, to), to: Math.max(from, to) };
  } catch {
    return null;
  }
}
