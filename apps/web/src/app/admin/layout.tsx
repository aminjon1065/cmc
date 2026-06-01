import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getMyAccess, isAdmin } from "@/lib/access";

/**
 * Gate for the whole `/admin/*` section (P1.4a / ADR-0022).
 *
 * The REAL authorisation boundary is the API: every admin endpoint is
 * `@Authorize`-gated, so a non-admin who reaches a page still can't mutate
 * anything. This redirect is the UX layer — it keeps non-admins out of the
 * section instead of showing them a wall of failed calls. Fail closed: a null
 * access set (no session / API down) is treated as not-admin.
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const access = await getMyAccess();
  if (!isAdmin(access)) {
    redirect("/dashboard");
  }
  return <>{children}</>;
}
