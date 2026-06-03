"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Region, UserSummary } from "@cmc/contracts";
import {
  assignRoleAction,
  deleteUserAction,
  removeRoleAction,
  resetPasswordAction,
  updateUserAction,
} from "./actions";

type RoleRef = { id: string; slug: string; name: string; isSystem: boolean };
type Res<T> = { ok: true; data: T } | { ok: false; error: string };

function fmt(ts: string): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

export function UserRow({
  user,
  roles,
  regions,
  isSelf,
}: {
  user: UserSummary;
  roles: RoleRef[];
  regions: Region[];
  isSelf: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reset, setReset] = useState<{ token: string; expiresAt: string } | null>(
    null,
  );
  const [addRoleId, setAddRoleId] = useState("");

  const assignedIds = new Set(user.roles.map((r) => r.id));
  const assignable = roles.filter((r) => !assignedIds.has(r.id));

  async function run<T>(p: Promise<Res<T>>) {
    setBusy(true);
    setError(null);
    const res = await p;
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  async function onReset() {
    setBusy(true);
    setError(null);
    const res = await resetPasswordAction(user.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setReset(res.data);
  }

  async function onDelete() {
    if (!confirm(`Delete ${user.email}? This cannot be undone.`)) return;
    await run(deleteUserAction(user.id));
  }

  return (
    <tr style={{ borderBottom: "0.5px solid var(--c-line-1)" }}>
      <td className="px-4 py-2.5 align-top">
        <div style={{ color: "var(--c-fg-1)" }}>{user.name}</div>
        <div
          className="cmc-mono text-[10.5px]"
          style={{ color: "var(--c-fg-3)" }}
        >
          {user.email}
        </div>
        {isSelf && (
          <span className="cmc-chip mt-1" style={{ color: "var(--c-fg-3)" }}>
            you
          </span>
        )}
      </td>

      <td className="px-4 py-2.5 align-top">
        <div className="flex flex-wrap items-center gap-1">
          {user.roles.length === 0 && (
            <span style={{ color: "var(--c-fg-4)" }}>—</span>
          )}
          {user.roles.map((r) => (
            <span
              key={r.id}
              className="cmc-chip inline-flex items-center gap-1"
            >
              {r.name}
              <button
                type="button"
                onClick={() => run(removeRoleAction(user.id, r.id))}
                disabled={busy}
                title="Remove role"
                style={{ color: "var(--c-fg-4)", cursor: "pointer" }}
              >
                ×
              </button>
            </span>
          ))}
          {assignable.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <select
                className="cmc-input"
                style={{ height: 24, padding: "0 6px", fontSize: 11 }}
                value={addRoleId}
                onChange={(e) => setAddRoleId(e.target.value)}
                disabled={busy}
              >
                <option value="">+ role</option>
                {assignable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              {addRoleId && (
                <button
                  type="button"
                  className="cmc-btn"
                  onClick={() => {
                    const rid = addRoleId;
                    setAddRoleId("");
                    void run(assignRoleAction(user.id, rid));
                  }}
                  disabled={busy}
                >
                  Add
                </button>
              )}
            </span>
          )}
        </div>
      </td>

      <td className="px-4 py-2.5 align-top">
        <select
          className="cmc-input"
          style={{ height: 24, padding: "0 6px", fontSize: 11, maxWidth: 150 }}
          value={user.regionId ?? ""}
          onChange={(e) =>
            run(updateUserAction(user.id, { regionId: e.target.value || null }))
          }
          disabled={busy}
          title="Assign this user to a region"
        >
          <option value="">Unassigned</option>
          {regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </td>

      <td className="px-4 py-2.5 align-top">
        {user.isActive ? (
          <span className="cmc-chip cmc-chip-ok">Active</span>
        ) : (
          <span className="cmc-chip" style={{ color: "var(--c-fg-3)" }}>
            Inactive
          </span>
        )}
        {!user.hasPassword && (
          <div className="mt-1">
            <span className="cmc-chip" style={{ color: "var(--c-sev-2)" }}>
              No password
            </span>
          </div>
        )}
      </td>

      <td
        className="cmc-mono px-4 py-2.5 align-top text-[10.5px]"
        style={{ color: "var(--c-fg-3)" }}
      >
        {user.lastLoginAt ? fmt(user.lastLoginAt) : "never"}
      </td>

      <td className="px-4 py-2.5 align-top">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="cmc-btn"
            onClick={() => run(updateUserAction(user.id, { isActive: !user.isActive }))}
            disabled={busy || isSelf}
            title={isSelf ? "You can't deactivate yourself" : undefined}
          >
            {user.isActive ? "Deactivate" : "Activate"}
          </button>
          <button
            type="button"
            className="cmc-btn"
            onClick={onReset}
            disabled={busy}
          >
            Reset password
          </button>
          <button
            type="button"
            className="cmc-btn"
            onClick={onDelete}
            disabled={busy || isSelf}
            style={{ color: isSelf ? undefined : "var(--c-sev-1)" }}
          >
            Delete
          </button>
        </div>

        {error && (
          <div className="mt-1 text-[11px]" style={{ color: "var(--c-sev-1)" }}>
            {error}
          </div>
        )}

        {reset && (
          <div
            className="mt-2 rounded-md p-2"
            style={{
              background: "var(--c-bg-2)",
              border: "0.5px solid var(--c-line-2)",
              maxWidth: 320,
            }}
          >
            <div className="cmc-label mb-1">Reset token — relay to the user</div>
            <div
              className="cmc-mono break-all text-[10.5px]"
              style={{ color: "var(--c-fg-2)" }}
            >
              {reset.token}
            </div>
            <div className="mt-1 text-[10px]" style={{ color: "var(--c-fg-4)" }}>
              Expires {fmt(reset.expiresAt)} UTC
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}
