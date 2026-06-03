"use server";

import type {
  MonitoringReplayResponse,
  MonitoringSummary,
  MonitoringSummaryResponse,
} from "@cmc/contracts";
import { authedApiFetch, ApiError } from "@/lib/server-api";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You don't have permission for that.";
    return `API ${err.status}`;
  }
  return err instanceof Error ? err.message : "Unknown error";
}

export async function getMonitoringSummaryAction(): Promise<
  ActionResult<MonitoringSummary>
> {
  try {
    const raw =
      await authedApiFetch<MonitoringSummaryResponse>("/monitoring/summary");
    return { ok: true, data: raw.summary };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function getMonitoringReplayAction(
  fromIso: string,
  toIso: string,
): Promise<ActionResult<MonitoringReplayResponse>> {
  try {
    const raw = await authedApiFetch<MonitoringReplayResponse>(
      `/monitoring/replay?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
    );
    return { ok: true, data: raw };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
