import type { MetadataRoute } from "next";
import { getPublicBranding } from "@/lib/branding";

/**
 * PWA manifest (P4.4 / ADR-0075). Makes the existing Next.js app installable as a
 * field companion — single codebase, offline-capable, no app store (sovereign /
 * air-gap friendly). Next auto-links this at `/manifest.webmanifest`.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { copy } = await getPublicBranding();
  return {
    name: copy.metaTitle,
    short_name: "CMC",
    description: copy.metaDescription,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0f14",
    theme_color: "#0b0f14",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
