import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import {
  WikiPagesListResponseSchema,
  WikiSpaceResponseSchema,
  type WikiPageSummary,
  type WikiSpace,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { WikiWorkspace } from "./wiki-workspace";

export const metadata: Metadata = { title: "Knowledge Base" };

async function fetchSpace(id: string): Promise<WikiSpace | null> {
  try {
    const raw = await authedApiFetch<unknown>(`/wiki/spaces/${id}`);
    const parsed = WikiSpaceResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data.space : null;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
      return null;
    }
    throw err;
  }
}

async function fetchPages(id: string): Promise<WikiPageSummary[]> {
  const raw = await authedApiFetch<unknown>(`/wiki/spaces/${id}/pages`);
  const parsed = WikiPagesListResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data.pages : [];
}

export default async function WikiSpacePage({
  params,
  searchParams,
}: {
  params: Promise<{ spaceId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { spaceId } = await params;
  const { page: initialPageId } = await searchParams;
  const session = await auth();
  const { copy } = await getBranding();
  const access = await getMyAccess();
  const space = await fetchSpace(spaceId);
  if (!space) notFound();
  const pages = await fetchPages(spaceId);

  return (
    <AppShell
      active="wiki"
      crumbs={["Knowledge", "Knowledge Base", space.name]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Operations" }}
    >
      <div
        className="flex items-center gap-3 px-5 py-3"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <Link
          href="/wiki"
          className="text-[12px] hover:underline"
          style={{ color: "var(--c-fg-3)" }}
        >
          ← Spaces
        </Link>
        <span className="text-[12px]" style={{ color: "var(--c-fg-4)" }}>
          /
        </span>
        <span
          className="cmc-display text-[15px] font-semibold"
          style={{ color: "var(--c-fg-1)" }}
        >
          {space.name}
        </span>
      </div>

      <WikiWorkspace
        spaceId={spaceId}
        initialPages={pages}
        initialPageId={initialPageId ?? null}
        canWrite={hasPermission(access, "wiki:write")}
        canManage={hasPermission(access, "wiki:manage")}
        currentUserId={access?.userId ?? null}
      />
    </AppShell>
  );
}
