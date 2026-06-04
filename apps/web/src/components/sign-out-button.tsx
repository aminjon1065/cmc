"use client";

import { LogOut } from "lucide-react";
import { signOut } from "next-auth/react";
import { useTranslations } from "next-intl";

export function SignOutButton() {
  const t = useTranslations("topbar");
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="cmc-btn cmc-btn-ghost"
      aria-label={t("signOut")}
    >
      <LogOut size={12} strokeWidth={1.7} />
      {t("signOut")}
    </button>
  );
}
