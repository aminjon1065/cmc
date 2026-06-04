"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createUserAction } from "./actions";

type RoleRef = { id: string; slug: string; name: string; isSystem: boolean };

export function CreateUserForm({ roles }: { roles: RoleRef[] }) {
  const router = useRouter();
  const t = useTranslations("admin");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roleSlugs, setRoleSlugs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleRole(slug: string) {
    setRoleSlugs((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await createUserAction({
      email,
      name,
      roleSlugs: roleSlugs.length ? roleSlugs : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEmail("");
    setName("");
    setRoleSlugs([]);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="cmc-label">{t("users.fName")}</span>
          <input
            className="cmc-input"
            style={{ width: 200 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("users.fNamePlaceholder")}
            maxLength={200}
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cmc-label">{t("users.fEmail")}</span>
          <input
            className="cmc-input"
            style={{ width: 240 }}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@org.tj"
            maxLength={320}
            required
          />
        </label>
        <button
          type="submit"
          className="cmc-btn cmc-btn-primary"
          disabled={busy}
        >
          {busy ? t("users.creating") : t("users.createUser")}
        </button>
      </div>

      {roles.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="cmc-label">{t("users.initialRoles")}</span>
          {roles.map((r) => (
            <label
              key={r.id}
              className="inline-flex items-center gap-1.5 text-[11.5px]"
              style={{ color: "var(--c-fg-2)" }}
            >
              <input
                type="checkbox"
                checked={roleSlugs.includes(r.slug)}
                onChange={() => toggleRole(r.slug)}
              />
              {r.name}
            </label>
          ))}
        </div>
      )}

      {error && (
        <div className="text-[11.5px]" style={{ color: "var(--c-sev-1)" }} role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
