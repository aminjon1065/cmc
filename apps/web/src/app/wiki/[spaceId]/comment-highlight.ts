import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { resolveAnchor } from "./comment-anchor";

/**
 * Renders highlight decorations for anchored comments (P4.1c / ADR-0060). The
 * comment list is pushed in via a transaction meta; decorations are recomputed
 * from the live doc on every state change, so the relative-position anchors
 * rebase as text is edited. Clicking a highlight calls `onActivate(id)`.
 */
export const commentHighlightKey = new PluginKey<HighlightState>(
  "commentHighlight",
);

export type AnchoredComment = { id: string; anchor: string };
type HighlightState = { comments: AnchoredComment[] };

export interface CommentHighlightOptions {
  onActivate: (id: string) => void;
}

export const CommentHighlight = Extension.create<CommentHighlightOptions>({
  name: "commentHighlight",

  addOptions() {
    return { onActivate: () => {} };
  },

  addProseMirrorPlugins() {
    const onActivate = this.options.onActivate;
    return [
      new Plugin<HighlightState>({
        key: commentHighlightKey,
        state: {
          init: () => ({ comments: [] }),
          apply(tr, value) {
            const meta = tr.getMeta(commentHighlightKey) as
              | HighlightState
              | undefined;
            return meta ?? value;
          },
        },
        props: {
          decorations(state) {
            const hs = commentHighlightKey.getState(state);
            if (!hs || hs.comments.length === 0) return DecorationSet.empty;
            const decos: Decoration[] = [];
            for (const c of hs.comments) {
              const range = resolveAnchor(state, c.anchor);
              if (!range) continue;
              decos.push(
                Decoration.inline(range.from, range.to, {
                  class: "wiki-comment-highlight",
                  "data-comment-id": c.id,
                }),
              );
            }
            return DecorationSet.create(state.doc, decos);
          },
          handleClick(view, pos) {
            const hs = commentHighlightKey.getState(view.state);
            if (!hs) return false;
            for (const c of hs.comments) {
              const range = resolveAnchor(view.state, c.anchor);
              if (range && pos >= range.from && pos <= range.to) {
                onActivate(c.id);
                return false;
              }
            }
            return false;
          },
        },
      }),
    ];
  },
});
