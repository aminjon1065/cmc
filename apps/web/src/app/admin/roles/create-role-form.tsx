"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { PermissionCatalogEntry } from "@cmc/contracts";
import { createRoleAction } from "./actions";
import { PermissionPicker } from "./permission-picker";

/** Auto-suggest a slug from the name (lowercase, underscores). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "");
}

export function CreateRoleForm({
  catalog,
}: {
  catalog: PermissionCatalogEntry[];
}) {
  const router = useRouter();
  const t = useTranslations("admin");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setSlug("");
    setSlugEdited(false);
    setDescription("");
    setSelected(new Set());
    setError(null);
  }

  function onName(v: string) {
    setName(v);
    if (!slugEdited) setSlug(slugify(v));
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await createRoleAction({
      slug,
      name,
      description: description.trim() || undefined,
      permissions: [...selected],
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    reset();
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        className="cmc-btn cmc-btn-primary"
        onClick={() => setOpen(true)}
      >
        {t("roles.newCustomRole")}
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="cmc-label">{t("roles.fName")}</span>
          <input
            className="cmc-input"
            style={{ width: 220 }}
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder={t("roles.fNamePlaceholder")}
            maxLength={128}
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">{t("roles.fSlug")}</span>
          <input
            className="cmc-input cmc-mono"
            style={{ width: 180 }}
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugEdited(true);
            }}
            placeholder={t("roles.fSlugPlaceholder")}
            maxLength={64}
            required
          />
        </label>
        <label className="flex flex-1 flex-col gap-1" style={{ minWidth: 200 }}>
          <span className="cmc-label">{t("roles.fDescription")}</span>
          <input
            className="cmc-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("roles.fDescriptionPlaceholder")}
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

      {error && (
        <div className="text-[11.5px]" style={{ color: "var(--c-sev-1)" }} role="alert">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button type="submit" className="cmc-btn cmc-btn-primary" disabled={busy}>
          {busy ? t("roles.creating") : t("roles.createRole")}
        </button>
        <button
          type="button"
          className="cmc-btn"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={busy}
        >
          {t("roles.cancel")}
        </button>
      </div>
    </form>
  );
}
