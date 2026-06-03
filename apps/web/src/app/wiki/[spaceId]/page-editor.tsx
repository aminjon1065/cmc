"use client";

import { useEffect } from "react";
import {
  useEditor,
  EditorContent,
  type Editor,
  type JSONContent,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { ProseMirrorDoc } from "@cmc/contracts";

/**
 * TipTap/ProseMirror editor for a wiki page. The document JSON round-trips
 * straight to the API (`content` is the same ProseMirror doc the backend
 * stores + derives plaintext from). SSR-safe via `immediatelyRender: false`.
 *
 * Remount this with a `key` (page id + load nonce) when the source content
 * changes — switching pages or restoring a version — so the editor re-seeds.
 * `editable` is applied reactively without a remount.
 */
export function PageEditor({
  content,
  editable,
  onChange,
}: {
  content: ProseMirrorDoc;
  editable: boolean;
  onChange: (doc: ProseMirrorDoc) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: content as JSONContent,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: "wiki-prose focus:outline-none" },
    },
    onUpdate: ({ editor }) => onChange(editor.getJSON() as ProseMirrorDoc),
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);

  if (!editor) {
    return (
      <div className="p-4 text-[12px]" style={{ color: "var(--c-fg-3)" }}>
        Loading editor…
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {editable && <EditorToolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

/**
 * The formatting toolbar, shared between the manual {@link PageEditor} and the
 * collaborative editor (`collab-page-editor.tsx`) so both expose the same marks.
 */
export function EditorToolbar({ editor }: { editor: Editor }) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 px-3 py-2"
      style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
    >
      <TbBtn
        on={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")}
        label="B"
        bold
      />
      <TbBtn
        on={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")}
        label="I"
        italic
      />
      <Sep />
      <TbBtn
        on={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive("heading", { level: 1 })}
        label="H1"
      />
      <TbBtn
        on={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })}
        label="H2"
      />
      <TbBtn
        on={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive("heading", { level: 3 })}
        label="H3"
      />
      <Sep />
      <TbBtn
        on={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
        label="• List"
      />
      <TbBtn
        on={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
        label="1. List"
      />
      <Sep />
      <TbBtn
        on={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive("blockquote")}
        label="❝"
      />
      <TbBtn
        on={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive("codeBlock")}
        label="</>"
      />
    </div>
  );
}

function Sep() {
  return (
    <span
      className="mx-0.5 inline-block h-3.5 w-px"
      style={{ background: "var(--c-line-2)" }}
    />
  );
}

function TbBtn({
  on,
  active,
  label,
  bold,
  italic,
}: {
  on: () => void;
  active: boolean;
  label: string;
  bold?: boolean;
  italic?: boolean;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={on}
      className="rounded px-1.5 py-0.5 text-[11px]"
      style={{
        color: active ? "var(--c-accent)" : "var(--c-fg-2)",
        background: active
          ? "color-mix(in srgb, var(--c-accent) 12%, transparent)"
          : "transparent",
        fontWeight: bold ? 700 : 500,
        fontStyle: italic ? "italic" : "normal",
      }}
    >
      {label}
    </button>
  );
}
