import type { Metadata } from "next";
import { auth } from "@/auth";
import { VideoRoomsListResponseSchema, type VideoRoom } from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { getTranslations } from "next-intl/server";
import { VideoWorkspace } from "./video-workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("video");
  return { title: t("metaTitle") };
}

type RoomsFetchError = {
  ok: false;
  errorKey: "errShape" | "errApi" | "errForbidden" | "errLoad";
  status?: number;
};

async function fetchRooms(): Promise<
  { ok: true; rooms: VideoRoom[] } | RoomsFetchError
> {
  try {
    const raw = await authedApiFetch<unknown>("/video/rooms");
    const parsed = VideoRoomsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorKey: "errShape" };
    return { ok: true, rooms: parsed.data.rooms };
  } catch (err) {
    if (err instanceof ApiError) {
      return err.status === 403
        ? { ok: false, errorKey: "errForbidden" }
        : { ok: false, errorKey: "errApi", status: err.status };
    }
    return { ok: false, errorKey: "errLoad" };
  }
}

export default async function VideoPage({
  searchParams,
}: {
  searchParams: Promise<{ join?: string }>;
}) {
  const session = await auth();
  const { copy } = await getBranding();
  const t = await getTranslations("video");
  const tc = await getTranslations("common");
  const [result, access, sp] = await Promise.all([
    fetchRooms(),
    getMyAccess(),
    searchParams,
  ]);
  const joinId = typeof sp.join === "string" ? sp.join : undefined;

  return (
    <AppShell
      active="video"
      crumbs={[t("crumbComms"), t("crumbVideo")]}
      tenant={session?.tenantSlug}
      branding={{ orgName: copy.orgName, orgShort: copy.orgShort }}
      user={{ name: session?.user?.name, role: tc("roleOps") }}
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
              {result.errorKey === "errApi"
                ? t("errApi", { status: result.status ?? 0 })
                : t(result.errorKey)}
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
