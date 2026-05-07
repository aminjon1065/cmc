import { ApiHealthCheck } from "@/components/api-health-check";

export default function HomePage() {
  return (
    <main className="container mx-auto flex min-h-screen flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <span className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          CMC Platform
        </span>
        <h1 className="text-4xl font-semibold tracking-tight">
          Operational intelligence workspace
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Skeleton is up. Modules will be added incrementally — see{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-sm">
            docs/ToR.md
          </code>{" "}
          for the long-term spec.
        </p>
      </header>

      <section className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-medium">Stack health</h2>
        <ApiHealthCheck />
      </section>
    </main>
  );
}
