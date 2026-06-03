import type { Metadata } from "next";
import { auth } from "@/auth";
import {
  ChatChannelsListResponseSchema,
  type ChatChannel,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { getBranding } from "@/lib/branding";
import { getMyAccess, hasPermission } from "@/lib/access";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import { ChatWorkspace } from "./chat-workspace";

export const metadata: Metadata = { title: "Chat" };

async function fetchChannels(): Promise<
  { ok: true; channels: ChatChannel[] } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/chat/channels");
    const parsed = ChatChannelsListResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Unexpected API shape." };
    return { ok: true, channels: parsed.data.channels };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        error:
          err.status === 403
            ? "You don't have permission to view chat."
            : `API ${err.status}`,
      };
    }
    return { ok: false, error: "Failed to load chat." };
  }
}

export default async function ChatPage() {
  const session = await auth();
  const { copy } = await getBranding();
  const [result, access] = await Promise.all([fetchChannels(), getMyAccess()]);

  return (
    <AppShell
      active="chat"
      crumbs={["Communication", "Chat"]}
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
        <ChatWorkspace
          initialChannels={result.channels}
          canWrite={hasPermission(access, "chat:write")}
          canManage={hasPermission(access, "chat:manage")}
          currentUserId={access?.userId ?? null}
        />
      )}
    </AppShell>
  );
}
