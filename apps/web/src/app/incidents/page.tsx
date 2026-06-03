import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import {
  IncidentsListResponseSchema,
  type IncidentSummary,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { fetchRegions, regionNameMap } from "@/lib/regions";
import { SeverityBadge, StatusBadge } from "@/components/cmc/incident-badges";
import { CreateIncidentForm } from "./create-incident-form";
import { IncidentFilters } from "./incident-filters";

export const metadata: Metadata = { title: "Incidents" };

const FILTER_KEYS = [
  "status",
  "severity",
  "region",
  "regionId",
  "type",
  "q",
] as const;
const PAGE_SIZE = 25;

function fmt(ts: string): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

type SearchParams = Record<string, string | string[] | undefined>;

async function fetchIncidents(
  qs: string,
): Promise<
  | { ok: true; data: ReturnType<typeof IncidentsListResponseSchema.parse> }
  | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>(`/incidents?${qs}`);
    const parsed = IncidentsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, data: parsed.data };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        error:
          err.status === 403
            ? "You don't have permission to view incidents."
            : `API ${err.status}`,
      };
    }
    return { ok: false, error: "Failed to load incidents." };
  }
}

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const session = await auth();
  const { copy } = await getBranding();
  const access = await getMyAccess();
  const canCreate = hasPermission(access, "incident:create");
  const regions = await fetchRegions();
  const regionName = regionNameMap(regions);

  const params = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = sp[k];
    if (typeof v === "string" && v.trim()) params.set(k, v.trim());
  }
  const offset = Math.max(Number(sp.offset ?? 0) || 0, 0);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));

  const result = await fetchIncidents(params.toString());

  function pageUrl(nextOffset: number): string {
    const u = new URLSearchParams();
    for (const k of FILTER_KEYS) {
      const v = sp[k];
      if (typeof v === "string" && v.trim()) u.set(k, v.trim());
    }
    if (nextOffset > 0) u.set("offset", String(nextOffset));
    return u.toString() ? `/incidents?${u.toString()}` : "/incidents";
  }

  return (
    <AppShell
      active="cases"
      crumbs={["Operations", "Incidents"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Operations" }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Operations · Incidents</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            Incidents
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
            {result.ok ? `${result.data.total} matching` : "—"} · report, triage,
            assign, and resolve.
          </div>
        </div>
        <div className="flex-1" />
        {canCreate && <CreateIncidentForm />}
      </div>

      <div className="flex flex-col gap-4 p-5">
        <div className="cmc-card">
          <div className="p-3">
            <IncidentFilters regions={regions} />
          </div>
        </div>

        <div className="cmc-card">
          {!result.ok ? (
            <div
              className="m-4 rounded-md p-3 text-[12px]"
              style={{
                color: "var(--c-sev-1)",
                background: "var(--c-sev-1-soft)",
                border:
                  "0.5px solid color-mix(in srgb, var(--c-sev-1) 30%, transparent)",
              }}
            >
              {result.error}
            </div>
          ) : result.data.incidents.length === 0 ? (
            <div className="p-6 text-center text-[12px]" style={{ color: "var(--c-fg-3)" }}>
              No incidents match.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr
                      className="text-left"
                      style={{
                        color: "var(--c-fg-4)",
                        borderBottom: "0.5px solid var(--c-line-2)",
                      }}
                    >
                      <th className="px-4 py-2 font-medium">Sev</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Summary</th>
                      <th className="px-4 py-2 font-medium">Region</th>
                      <th className="px-4 py-2 font-medium">Type</th>
                      <th className="px-4 py-2 font-medium">Assignee</th>
                      <th className="px-4 py-2 font-medium">Occurred</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.incidents.map((i: IncidentSummary) => (
                      <tr
                        key={i.id}
                        style={{ borderBottom: "0.5px solid var(--c-line-1)" }}
                      >
                        <td className="px-4 py-2.5">
                          <SeverityBadge severity={i.severity} />
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={i.status} />
                        </td>
                        <td className="px-4 py-2.5">
                          <Link
                            href={`/incidents/${i.id}`}
                            style={{ color: "var(--c-fg-1)" }}
                            className="hover:underline"
                          >
                            {i.summary}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5" style={{ color: "var(--c-fg-2)" }}>
                          {i.region}
                          {i.regionId && regionName.get(i.regionId) && (
                            <span
                              className="cmc-chip ml-1.5"
                              style={{ color: "var(--c-fg-3)" }}
                              title="Region (zone)"
                            >
                              {regionName.get(i.regionId)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: "var(--c-fg-2)" }}>
                          {i.type}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: "var(--c-fg-3)" }}>
                          {i.assignedTo?.name ?? "—"}
                        </td>
                        <td
                          className="cmc-mono px-4 py-2.5 text-[10.5px]"
                          style={{ color: "var(--c-fg-3)" }}
                        >
                          {fmt(i.occurredAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div
                className="flex items-center gap-3 px-4 py-2.5 text-[11px]"
                style={{
                  color: "var(--c-fg-3)",
                  borderTop: "0.5px solid var(--c-line-2)",
                }}
              >
                <span>
                  {offset + 1}–{offset + result.data.incidents.length} of{" "}
                  {result.data.total}
                </span>
                <div className="flex-1" />
                {offset > 0 && (
                  <Link
                    href={pageUrl(Math.max(offset - PAGE_SIZE, 0))}
                    className="cmc-btn"
                  >
                    ← Prev
                  </Link>
                )}
                {offset + PAGE_SIZE < result.data.total && (
                  <Link href={pageUrl(offset + PAGE_SIZE)} className="cmc-btn">
                    Next →
                  </Link>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
