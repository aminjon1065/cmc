"use client";

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { INCIDENT_STATUSES, type Region } from "@cmc/contracts";
import { STATUS_LABEL } from "@/components/cmc/incident-badges";

const KEYS = ["status", "severity", "region", "regionId", "type", "q"];

export function IncidentFilters({ regions }: { regions: Region[] }) {
  const router = useRouter();
  const sp = useSearchParams();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const next = new URLSearchParams();
    for (const k of KEYS) {
      const v = String(fd.get(k) ?? "").trim();
      if (v) next.set(k, v);
    }
    router.push(next.toString() ? `/incidents?${next.toString()}` : "/incidents");
  }

  const hasFilters = KEYS.some((k) => sp.get(k));

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="cmc-label">Status</span>
        <select
          name="status"
          className="cmc-input"
          style={{ width: 130 }}
          defaultValue={sp.get("status") ?? ""}
        >
          <option value="">All</option>
          {INCIDENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="cmc-label">Severity</span>
        <select
          name="severity"
          className="cmc-input"
          style={{ width: 90 }}
          defaultValue={sp.get("severity") ?? ""}
        >
          <option value="">All</option>
          {[1, 2, 3, 4, 5].map((s) => (
            <option key={s} value={s}>
              SEV-{s}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="cmc-label">Region</span>
        <input
          name="region"
          className="cmc-input"
          style={{ width: 130 }}
          defaultValue={sp.get("region") ?? ""}
        />
      </label>
      {regions.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="cmc-label">Zone</span>
          <select
            name="regionId"
            className="cmc-input"
            style={{ width: 150 }}
            defaultValue={sp.get("regionId") ?? ""}
          >
            <option value="">All zones</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="cmc-label">Type</span>
        <input
          name="type"
          className="cmc-input"
          style={{ width: 130 }}
          defaultValue={sp.get("type") ?? ""}
        />
      </label>
      <label className="flex flex-1 flex-col gap-1" style={{ minWidth: 160 }}>
        <span className="cmc-label">Search summary</span>
        <input
          name="q"
          className="cmc-input"
          defaultValue={sp.get("q") ?? ""}
          placeholder="keyword…"
        />
      </label>
      <button type="submit" className="cmc-btn">
        Filter
      </button>
      {hasFilters && (
        <Link href="/incidents" className="cmc-btn">
          Clear
        </Link>
      )}
    </form>
  );
}
