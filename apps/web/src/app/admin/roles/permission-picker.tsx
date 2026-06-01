"use client";

import type { PermissionCatalogEntry } from "@cmc/contracts";

/**
 * Catalog permission picker, grouped by domain. Controlled: the parent owns the
 * selected-keys set. Shared by the create form and the inline role editor.
 */
export function PermissionPicker({
  catalog,
  selected,
  onToggle,
  disabled,
}: {
  catalog: PermissionCatalogEntry[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  disabled?: boolean;
}) {
  const byDomain = new Map<string, PermissionCatalogEntry[]>();
  for (const p of catalog) {
    const arr = byDomain.get(p.domain) ?? [];
    arr.push(p);
    byDomain.set(p.domain, arr);
  }

  return (
    <div className="flex flex-col gap-2.5">
      {[...byDomain.entries()].map(([domain, perms]) => (
        <div key={domain} className="flex flex-col gap-1">
          <div
            className="text-[9.5px] font-semibold uppercase"
            style={{ color: "var(--c-fg-4)", letterSpacing: "0.06em" }}
          >
            {domain}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {perms.map((p) => (
              <label
                key={p.key}
                className="inline-flex items-center gap-1.5 text-[11.5px]"
                style={{ color: "var(--c-fg-2)" }}
                title={p.description}
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.key)}
                  onChange={() => onToggle(p.key)}
                  disabled={disabled}
                />
                <span className="cmc-mono">{p.action}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
