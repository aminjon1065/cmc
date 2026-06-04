import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import {
  SearchResponseSchema,
  type SearchResult,
  type SearchResultType,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { getTranslations } from "next-intl/server";
import { SearchBox } from "./search-box";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("search");
  return { title: t("metaTitle") };
}

type SearchParams = Record<string, string | string[] | undefined>;

type SearchFetchError = {
  ok: false;
  errorKey: "errShape" | "errApi" | "errFailed";
  status?: number;
};

const TYPE_ORDER: SearchResultType[] = ["incident", "case", "document"];

/** Where a result links, or null when no detail view exists yet. */
function hrefFor(r: SearchResult): string | null {
  switch (r.type) {
    case "incident":
      return `/incidents/${r.id}`;
    case "document":
      return "/documents";
    default:
      return null; // cases have no detail page yet
  }
}

async function runSearch(
  q: string,
): Promise<{ ok: true; results: SearchResult[] } | SearchFetchError> {
  try {
    const raw = await authedApiFetch<unknown>(
      `/search?q=${encodeURIComponent(q)}&limit=50`,
    );
    const parsed = SearchResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, results: parsed.data.results };
  } catch (err) {
    if (err instanceof ApiError)
      return { ok: false, errorKey: "errApi", status: err.status };
    return { ok: false, errorKey: "errFailed" };
  }
}

async function SourceBadge({ source }: { source: SearchResult["source"] }) {
  const t = await getTranslations("search");
  const isOs = source === "opensearch";
  return (
    <span
      className="cmc-mono rounded px-1.5 py-0.5 text-[9.5px] uppercase"
      style={{
        letterSpacing: "0.04em",
        color: isOs ? "var(--c-accent)" : "var(--c-fg-3)",
        background: isOs
          ? "color-mix(in srgb, var(--c-accent) 12%, transparent)"
          : "var(--c-bg-3)",
      }}
      title={isOs ? t("sourceOpenSearch") : t("sourcePostgres")}
    >
      {source}
    </span>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("search");
  const tc = await getTranslations("common");
  const q = (typeof sp.q === "string" ? sp.q : "").trim();

  const result = q.length > 0 ? await runSearch(q) : null;

  // Group the (globally RRF-ranked) results by type, preserving order.
  const groups = new Map<SearchResultType, SearchResult[]>();
  if (result?.ok) {
    for (const r of result.results) {
      const list = groups.get(r.type) ?? [];
      list.push(r);
      groups.set(r.type, list);
    }
  }
  const total = result?.ok ? result.results.length : 0;

  return (
    <AppShell
      active="search"
      crumbs={[t("crumbIntel"), t("crumbSearch")]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleOps") }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">{t("kicker")}</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            {t("title")}
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            {q ? t("results", { count: total, q }) : t("subtitleEmpty")}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <div className="cmc-card">
          <div className="p-3">
            <SearchBox />
          </div>
        </div>

        {q.length === 0 ? (
          <div
            className="cmc-card p-6 text-center text-[12px]"
            style={{ color: "var(--c-fg-3)" }}
          >
            {t("promptEmpty")}
          </div>
        ) : result && !result.ok ? (
          <div
            className="m-0 rounded-md p-3 text-[12px]"
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
        ) : total === 0 ? (
          <div
            className="cmc-card p-6 text-center text-[12px]"
            style={{ color: "var(--c-fg-3)" }}
          >
            {t("noResults", { q })}
          </div>
        ) : (
          TYPE_ORDER.filter((t) => groups.has(t)).map((type) => (
            <div key={type} className="cmc-card">
              <div
                className="flex items-center gap-2 px-4 py-2.5"
                style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
              >
                <span className="cmc-label">
                  {type === "incident"
                    ? t("typeIncident")
                    : type === "case"
                      ? t("typeCase")
                      : t("typeDocument")}
                </span>
                <span className="text-[10.5px]" style={{ color: "var(--c-fg-4)" }}>
                  {groups.get(type)!.length}
                </span>
              </div>
              <ul>
                {groups.get(type)!.map((r) => {
                  const href = hrefFor(r);
                  const inner = (
                    <>
                      <div className="flex items-center gap-2">
                        <span
                          className="truncate text-[12.5px] font-medium"
                          style={{ color: "var(--c-fg-1)" }}
                        >
                          {r.title}
                        </span>
                        <SourceBadge source={r.source} />
                      </div>
                      {r.snippet && (
                        <div
                          className="mt-0.5 truncate text-[11px]"
                          style={{ color: "var(--c-fg-3)" }}
                        >
                          {r.snippet}
                        </div>
                      )}
                    </>
                  );
                  return (
                    <li
                      key={`${r.type}:${r.id}`}
                      style={{ borderBottom: "0.5px solid var(--c-line-1)" }}
                    >
                      {href ? (
                        <Link
                          href={href as never}
                          className="block px-4 py-2.5 hover:bg-[var(--c-bg-2)]"
                        >
                          {inner}
                        </Link>
                      ) : (
                        <div className="px-4 py-2.5">{inner}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </AppShell>
  );
}
