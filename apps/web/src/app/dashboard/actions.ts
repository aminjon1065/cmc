"use server";

import { type AnomaliesResponse, AnomaliesResponseSchema } from "@cmc/contracts";
import { authedApiFetch } from "@/lib/server-api";

/**
 * Realtime anomalies (P4.8 / ADR-0066) for the dashboard widget's poll. Returns
 * null on any error so the widget keeps its last good state.
 */
export async function fetchAnomaliesAction(): Promise<AnomaliesResponse | null> {
  try {
    const raw = await authedApiFetch<unknown>("/analytics/anomalies");
    const parsed = AnomaliesResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
