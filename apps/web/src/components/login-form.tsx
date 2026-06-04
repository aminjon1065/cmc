"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { syncPreferencesToCookies } from "@/lib/preferences";

/**
 * Only accept a same-origin path: must start with `/` and not `//` (which
 * is a protocol-relative URL and would let an attacker redirect off-site
 * via `?next=//evil.example/clone`).
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/dashboard";
  }
  return raw;
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));
  const t = useTranslations("login");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (!res || res.error) {
        setError(t("invalidCreds"));
        return;
      }
      // Best-effort: seed theme/locale cookies from the saved profile
      // (ADR-0078). NEVER let this block the redirect — a failed or stale
      // server action must not trap the user on the login page.
      try {
        await syncPreferencesToCookies();
      } catch {
        /* ignore — preference sync is best-effort */
      }
      router.push(next);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div>
        <label className="cmc-label mb-1.5 block">{t("emailLabel")}</label>
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="cmc-input cmc-input-lg"
          placeholder="rustam.aliyev@cdtj.gov"
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="cmc-label">{t("passwordLabel")}</label>
          <button
            type="button"
            className="text-[10px]"
            style={{ color: "var(--c-accent)" }}
          >
            {t("needHelp")}
          </button>
        </div>
        <input
          type="password"
          autoComplete="current-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="cmc-input cmc-input-lg"
          placeholder="••••••••••"
        />
      </div>

      {error && (
        <p
          className="rounded-md px-3 py-2 text-[12px]"
          style={{
            color: "var(--c-sev-1)",
            background: "var(--c-sev-1-soft)",
            border: "0.5px solid color-mix(in srgb, var(--c-sev-1) 30%, transparent)",
          }}
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="cmc-btn cmc-btn-primary cmc-btn-lg mt-1.5 w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? t("signingIn") : t("continue")}
      </button>
    </form>
  );
}
