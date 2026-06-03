"use client";

import { useEffect, useRef } from "react";
import Hls from "hls.js";

/**
 * HLS player (P4.5b / ADR-0063). Plays the BFF-proxied playlist via hls.js
 * (with native-HLS fallback for Safari). Loaded client-only (`hls.js` touches
 * the DOM/MediaSource). The playlist + segments are fetched same-origin so the
 * session cookie authorises them through the BFF — no token in the player.
 */
export function MediaPlayer({ assetId }: { assetId: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const src = `/api/media/${assetId}/playlist.m3u8`;

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
    // Safari / native HLS.
    video.src = src;
    return undefined;
  }, [assetId]);

  return (
    <video
      ref={ref}
      controls
      playsInline
      style={{ width: "100%", borderRadius: 8, background: "#000", maxHeight: 480 }}
    />
  );
}
