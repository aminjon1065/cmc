"use client";

import "@livekit/components-styles";
import { LiveKitRoom, VideoConference } from "@livekit/components-react";

/**
 * The live conferencing surface (P4.2b / ADR-0061). Isolated in its own module
 * so it can be loaded with `next/dynamic({ ssr: false })` — `livekit-client`
 * touches browser-only APIs and must not run during SSR. `VideoConference` is
 * LiveKit's prebuilt UI (participant grid, device controls, screenshare, its own
 * leave button → `onDisconnected`).
 */
export function RoomStage({
  token,
  serverUrl,
  onLeave,
}: {
  token: string;
  serverUrl: string;
  onLeave: () => void;
}) {
  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect
      video
      audio
      onDisconnected={onLeave}
      data-lk-theme="default"
      style={{ height: "100%", borderRadius: 8, overflow: "hidden" }}
    >
      <VideoConference />
    </LiveKitRoom>
  );
}
