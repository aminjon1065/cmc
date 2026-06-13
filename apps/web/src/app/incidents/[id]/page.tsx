import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import {
  IncidentDetailResponseSchema,
  IncidentAssigneesResponseSchema,
  type IncidentAssigneesResponse,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { fetchRegions, regionNameMap } from "@/lib/regions";
import { getTranslations } from "next-intl/server";
import { SeverityBadge, StatusBadge } from "@/components/cmc/incident-badges";
import { IncidentActions } from "./incident-actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("incidents");
  return { title: t("metaDetail") };
}

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "—";
}

async function fetchAssignees(canAssign: boolean): Promise<
  IncidentAssigneesResponse["assignees"]
> {
  if (!canAssign) return [];
  try {
    const raw = await authedApiFetch<unknown>("/incidents/assignees");
    const parsed = IncidentAssigneesResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data.assignees : [];
  } catch {
    return [];
  }
}

export default async function IncidentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("incidents");
  const access = await getMyAccess();

  let detail;
  try {
    const raw = await authedApiFetch<unknown>(`/incidents/${id}`);
    const parsed = IncidentDetailResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error("shape");
    detail = parsed.data.incident;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const canWrite = hasPermission(access, "incident:write");
  const canResolve = hasPermission(access, "incident:resolve");
  const canAssign = hasPermission(access, "incident:assign");
  const canDelete = hasPermission(access, "incident:delete");
  const assignees = await fetchAssignees(canAssign);
  const regionName = regionNameMap(await fetchRegions());

  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex gap-3 py-1.5">
      <div className="w-32 shrink-0 text-[11px]" style={{ color: "var(--c-fg-4)" }}>
        {k}
      </div>
      <div className="text-[12px]" style={{ color: "var(--c-fg-2)" }}>
        {v}
      </div>
    </div>
  );

  return (
    <AppShell
      active="cases"
      crumbs={[t("crumbOps"), t("crumbIncidents"), detail.summary]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: t("crumbOps") }}
    >
      <div
        className="flex items-center gap-3 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <Link href="/incidents" className="cmc-btn cmc-btn-ghost">
          {t("detailBack")}
        </Link>
        <SeverityBadge severity={detail.severity} />
        <StatusBadge status={detail.status} />
        <div className="min-w-0">
          <div
            className="truncate text-[16px] font-semibold"
            style={{ color: "var(--c-fg-1)" }}
          >
            {detail.summary}
          </div>
          <div
            className="cmc-mono text-[10.5px]"
            style={{ color: "var(--c-fg-4)" }}
          >
            {detail.id}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-3">
        {/* Details */}
        <div className="cmc-card lg:col-span-2">
          <div className="cmc-card-header">
            <span className="cmc-label">{t("detailDetails")}</span>
          </div>
          <div className="flex flex-col p-4">
            <Row k={t("dType")} v={detail.type} />
            <Row k={t("dRegion")} v={detail.region} />
            <Row
              k={t("dZone")}
              v={
                detail.regionId ? (regionName.get(detail.regionId) ?? "—") : "—"
              }
            />
            <Row k={t("dSource")} v={detail.source ?? "—"} />
            <Row k={t("dOccurred")} v={fmt(detail.occurredAt)} />
            <Row
              k={t("dLocation")}
              v={
                detail.latitude != null && detail.longitude != null
                  ? `${detail.latitude}, ${detail.longitude}`
                  : "—"
              }
            />
            <Row k={t("dReportedBy")} v={detail.reportedBy?.name ?? "—"} />
            <Row k={t("dAssignedTo")} v={detail.assignedTo?.name ?? t("dUnassigned")} />
            <Row k={t("dResolvedAt")} v={fmt(detail.resolvedAt)} />
            <Row
              k={t("dDescription")}
              v={
                detail.description ? (
                  <span style={{ whiteSpace: "pre-wrap" }}>
                    {detail.description}
                  </span>
                ) : (
                  "—"
                )
              }
            />
          </div>
        </div>

        {/* Actions */}
        <div className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">{t("detailActions")}</span>
          </div>
          <div className="p-4">
            <IncidentActions
              incident={detail}
              canWrite={canWrite}
              canResolve={canResolve}
              canAssign={canAssign}
              canDelete={canDelete}
              assignees={assignees}
            />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
