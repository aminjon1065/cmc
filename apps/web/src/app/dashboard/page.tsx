import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { type MeResponse, MeResponseSchema } from "@cmc/contracts";
import { SignOutButton } from "@/components/sign-out-button";

export const metadata: Metadata = {
  title: "Dashboard",
};

async function fetchMe(): Promise<
  | { ok: true; data: MeResponse }
  | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/auth/me");
    const parsed = MeResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "API returned an unexpected shape" };
    }
    return { ok: true, data: parsed.data };
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, error: `API ${err.status}: ${err.message}` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export default async function DashboardPage() {
  const session = await auth();
  const me = await fetchMe();

  return (
    <main className="container mx-auto flex min-h-screen flex-col gap-8 px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Dashboard
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">
            Welcome{session?.user?.name ? `, ${session.user.name}` : ""}
          </h1>
          <p className="text-sm text-muted-foreground">
            Tenant: <code className="font-mono">{session?.tenantSlug}</code>
          </p>
        </div>
        <SignOutButton />
      </header>

      <nav className="flex flex-wrap gap-3">
        <Link
          href="/documents"
          className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Documents →
        </Link>
      </nav>

      <section className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-medium">/auth/me (server-side fetch)</h2>
        {me.ok ? (
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(me.data, null, 2)}
          </pre>
        ) : (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <p className="font-medium text-destructive">API call failed</p>
            <p className="mt-1 text-muted-foreground">{me.error}</p>
          </div>
        )}
      </section>
    </main>
  );
}
