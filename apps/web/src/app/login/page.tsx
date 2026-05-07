import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

// `useSearchParams` inside <LoginForm> bails the route out of static
// pre-rendering — wrap it in <Suspense> so the rest of the page can be
// pre-rendered while the form hydrates.
export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-8 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Sign in to CMC Platform
          </h1>
          <p className="text-sm text-muted-foreground">
            Use the seeded admin credentials for local dev.
          </p>
        </div>
        <Suspense fallback={<LoginFormSkeleton />}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}

function LoginFormSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="h-9 animate-pulse rounded-md bg-muted" />
      <div className="h-9 animate-pulse rounded-md bg-muted" />
      <div className="h-10 animate-pulse rounded-md bg-muted" />
    </div>
  );
}
