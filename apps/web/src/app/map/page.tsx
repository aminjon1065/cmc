import type { Metadata } from "next";
import { auth } from "@/auth";
import { authedApiFetch } from "@/lib/server-api";
import {
  GisLayersListResponseSchema,
  type GisLayerResponse,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { MapView } from "@/components/cmc/map-view";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("map");
  return { title: t("metaTitle") };
}

async function fetchLayers(): Promise<GisLayerResponse[]> {
  try {
    const raw = await authedApiFetch<unknown>("/gis/layers");
    const parsed = GisLayersListResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data.layers : [];
  } catch {
    return [];
  }
}

export default async function MapPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("map");
  const tc = await getTranslations("common");
  const layers = await fetchLayers();

  return (
    <AppShell
      active="gis"
      crumbs={[t("crumbGis"), t("crumbMap")]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleOpsLead") }}
    >
      <MapView layers={layers} />
    </AppShell>
  );
}
