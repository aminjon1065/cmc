import { RegionsListResponseSchema, type Region } from "@cmc/contracts";
import { authedApiFetch } from "@/lib/server-api";

/**
 * Fetch the tenant's regions (P4.6) for admin + filter UIs. Best-effort: returns
 * `[]` on any error so a page never hard-fails because regions couldn't load.
 */
export async function fetchRegions(): Promise<Region[]> {
  try {
    const raw = await authedApiFetch<unknown>("/regions");
    const parsed = RegionsListResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data.regions : [];
  } catch {
    return [];
  }
}

/** id → display name, for rendering region badges. */
export function regionNameMap(regions: Region[]): Map<string, string> {
  return new Map(regions.map((r) => [r.id, r.name]));
}
