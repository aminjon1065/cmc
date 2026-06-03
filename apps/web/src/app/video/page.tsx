import type { Metadata } from "next";
import { auth } from "@/auth";
import { VideoRoomsListResponseSchema, type VideoRoom } from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { VideoWorkspace } from "./video-workspace";

export const metadata: Metadata = { title: "Video" };

async function fetchRooms(): Promise<
  { ok: true; rooms: VideoRoom[] } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/video/rooms");
    const parsed = VideoRoomsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, rooms: parsed.data.rooms };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        error:
          err.status === 403
            ? "You don't have permission to view video rooms."
            : `API ${err.status}`,
      };
    }
    return { ok: false, error: "Failed to load video rooms." };
  }
}

export default async function VideoPage({
  searchParams,
}: {
  searchParams: Promise<{ join?: string }>;
}) {
  const session = await auth();
  const { copy } = await getBranding();
  const [result, access, sp] = await Promise.all([
    fetchRooms(),
    getMyAccess(),
    searchParams,
  ]);
  const joinId = typeof sp.join === "string" ? sp.join : undefined;

  return (
    <AppShell
      active="video"
      crumbs={["Communication", "Video"]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: "Operations" }}
    >
      {!result.ok ? (
        <div className="p-5">
          <div className="cmc-card">
            <div
              className="m-4 rounded-md p-3 text-[12px]"
              style={{
                color: "var(--c-sev-1)",
                background: "var(--c-sev-1-soft)",
                border:
                  "0.5px solid color-mix(in srgb, var(--c-sev-1) 30%, transparent)",
              }}
            >
              {result.error}
            </div>
          </div>
        </div>
      ) : (
        <VideoWorkspace
          initialRooms={result.rooms}
          canWrite={hasPermission(access, "video:write")}
          canManage={hasPermission(access, "video:manage")}
          currentUserId={access?.userId ?? null}
          initialJoinRoomId={joinId}
        />
      )}
    </AppShell>
  );
}
