"use client";

import { LogOut } from "lucide-react";
import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="cmc-btn cmc-btn-ghost"
      aria-label="Sign out"
    >
      <LogOut size={12} strokeWidth={1.7} />
      Sign out
    </button>
  );
}
