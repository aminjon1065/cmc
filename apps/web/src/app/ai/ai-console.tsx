"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { RagAskResponse, RagCitation } from "@cmc/contracts";
import { askAiAction, type AiAskResult } from "./actions";

/** Where a cited source links, or null when no detail view exists. */
function citationHref(c: RagCitation): string | null {
  switch (c.type) {
    case "incident":
      return `/incidents/${c.id}`;
    case "document":
      return "/documents";
    default:
      return null;
  }
}

export function AiConsole() {
  const t = useTranslations("ai");
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AiAskResult | null>(null);

  async function submit() {
    const q = question.trim();
    if (!q || pending) return;
    setPending(true);
    setResult(null);
    try {
      setResult(await askAiAction(q));
    } catch {
      setResult({ ok: false, errorKey: "errFailed" });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="cmc-card p-3">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          rows={3}
          placeholder={t("placeholder")}
          className="cmc-input w-full resize-y"
          style={{ minHeight: 72 }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10.5px]" style={{ color: "var(--c-fg-4)" }}>
            {t("hint")}
          </span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={pending || question.trim().length === 0}
            className="cmc-btn cmc-btn-primary"
          >
            {pending ? t("asking") : t("ask")}
          </button>
        </div>
      </div>

      {result && !result.ok && (
        <div
          className="rounded-md p-3 text-[12px]"
          style={{
            color: "var(--c-sev-1)",
            background: "var(--c-sev-1-soft)",
            border:
              "0.5px solid color-mix(in srgb, var(--c-sev-1) 30%, transparent)",
          }}
        >
          {result.errorKey === "errApi"
            ? t("errApi", { status: result.status ?? 0 })
            : t(result.errorKey)}
        </div>
      )}

      {result?.ok && <AiAnswer data={result.data} />}
    </div>
  );
}

function AiAnswer({ data }: { data: RagAskResponse }) {
  const t = useTranslations("ai");
  const grounded = data.grounded;
  return (
    <div className="cmc-card">
      <div
        className="flex items-center gap-2 px-4 py-2.5"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <span className="cmc-label">{t("answerTitle")}</span>
        <span
          className="cmc-mono rounded px-1.5 py-0.5 text-[9.5px]"
          style={{
            color: grounded ? "var(--c-accent)" : "var(--c-sev-2)",
            background: grounded
              ? "var(--c-accent-soft)"
              : "var(--c-sev-2-soft)",
          }}
        >
          {grounded ? t("grounded") : t("ungrounded")}
        </span>
        <div className="flex-1" />
        <span
          className="cmc-mono text-[9.5px]"
          style={{ color: "var(--c-fg-4)" }}
        >
          {data.model}
        </span>
      </div>

      <div
        className="whitespace-pre-wrap px-4 py-3 text-[12.5px]"
        style={{ color: "var(--c-fg-1)", lineHeight: 1.55 }}
      >
        {data.answer}
      </div>

      {data.citations.length > 0 && (
        <div className="px-4 pb-3">
          <div className="cmc-label mb-1.5">{t("sourcesTitle")}</div>
          <ol className="flex flex-col gap-1">
            {data.citations.map((c, i) => {
              const href = citationHref(c);
              const inner = (
                <span className="text-[11.5px]">
                  <span className="cmc-mono" style={{ color: "var(--c-fg-4)" }}>
                    [{i + 1}]
                  </span>{" "}
                  <span style={{ color: "var(--c-fg-2)" }}>{c.title}</span>{" "}
                  <span
                    className="cmc-mono text-[9.5px]"
                    style={{ color: "var(--c-fg-4)" }}
                  >
                    {c.type}
                  </span>
                </span>
              );
              return (
                <li key={`${c.type}:${c.id}`}>
                  {href ? (
                    <Link href={href as never} className="hover:underline">
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
