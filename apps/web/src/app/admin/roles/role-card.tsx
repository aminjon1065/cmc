"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { PermissionCatalogEntry } from "@cmc/contracts";
import { deleteRoleAction, updateRoleAction } from "./actions";
import { PermissionPicker } from "./permission-picker";

type Role = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
};

export function RoleCard({
  role,
  catalog,
}: {
  role: Role;
  catalog: PermissionCatalogEntry[];
}) {
  const router = useRouter();
  const t = useTranslations("admin");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    new Set(role.permissions),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function cancel() {
    setName(role.name);
    setDescription(role.description ?? "");
    setSelected(new Set(role.permissions));
    setError(null);
    setEditing(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    const res = await updateRoleAction(role.id, {
      name,
      description: description.trim() || null,
      permissions: [...selected],
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  async function onDelete() {
    if (!confirm(t("roles.confirmDelete", { name: role.name }))) return;
    setBusy(true);
    setError(null);
    const res = await deleteRoleAction(role.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="cmc-card">
      <div className="cmc-card-header">
        <span className="cmc-label">{role.name}</span>
        <span className="cmc-mono ml-2 text-[10px]" style={{ color: "var(--c-fg-4)" }}>
          {role.slug}
        </span>
        <div className="flex-1" />
        {role.isSystem ? (
          <span className="cmc-chip" style={{ color: "var(--c-fg-3)" }}>
            {t("roles.system")}
          </span>
        ) : (
          <span className="cmc-chip cmc-chip-accent">{t("roles.custom")}</span>
        )}
      </div>

      <div className="flex flex-col gap-2.5 p-4">
        {!editing ? (
          <>
            {role.description && (
              <div className="text-[11.5px]" style={{ color: "var(--c-fg-3)" }}>
                {role.description}
              </div>
            )}
            <div className="flex flex-wrap gap-1">
              {role.permissions.length === 0 ? (
                <span style={{ color: "var(--c-fg-4)" }}>
                  {t("roles.noPermissions")}
                </span>
              ) : (
                role.permissions.map((p) => (
                  <span key={p} className="cmc-chip cmc-mono text-[10px]">
                    {p}
                  </span>
                ))
              )}
            </div>
            {!role.isSystem && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="cmc-btn"
                  onClick={() => setEditing(true)}
                >
                  {t("roles.edit")}
                </button>
                <button
                  type="button"
                  className="cmc-btn"
                  onClick={onDelete}
                  disabled={busy}
                  style={{ color: "var(--c-sev-1)" }}
                >
                  {t("roles.delete")}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="cmc-label">{t("roles.fName")}</span>
                <input
                  className="cmc-input"
                  style={{ width: 220 }}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={128}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1" style={{ minWidth: 200 }}>
                <span className="cmc-label">{t("roles.fDescription")}</span>
                <input
                  className="cmc-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={255}
                />
              </label>
            </div>
            <div>
              <div className="cmc-label mb-1.5">{t("roles.permissions")}</div>
              <PermissionPicker
                catalog={catalog}
                selected={selected}
                onToggle={toggle}
                disabled={busy}
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="cmc-btn cmc-btn-primary"
                onClick={onSave}
                disabled={busy}
              >
                {busy ? t("roles.saving") : t("roles.save")}
              </button>
              <button
                type="button"
                className="cmc-btn"
                onClick={cancel}
                disabled={busy}
              >
                {t("roles.cancel")}
              </button>
            </div>
          </>
        )}

        {error && (
          <div className="text-[11px]" style={{ color: "var(--c-sev-1)" }} role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
