import { apiFetch, ApiError } from "@/lib/api";
import type { HealthCheckResponse } from "@cmc/contracts";

async function fetchHealth(): Promise<
  { ok: true; data: HealthCheckResponse } | { ok: false; error: string }
> {
  try {
    const data = await apiFetch<HealthCheckResponse>("/health");
    return { ok: true, data };
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

export async function ApiHealthCheck() {
  const result = await fetchHealth();

  if (!result.ok) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
        <p className="font-medium text-destructive">API unreachable</p>
        <p className="mt-1 text-muted-foreground">{result.error}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Start it with <code className="rounded bg-muted px-1">pnpm dev</code>{" "}
          from the repo root.
        </p>
      </div>
    );
  }

  return (
    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-muted-foreground">Status</dt>
        <dd className="font-medium text-emerald-600">{result.data.status}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Version</dt>
        <dd className="font-mono">{result.data.version}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Uptime</dt>
        <dd className="font-mono">{result.data.uptimeSeconds.toFixed(0)}s</dd>
      </div>
    </dl>
  );
}
