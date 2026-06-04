import type { Metadata, Viewport } from "next";
import { Geist, Onest, JetBrains_Mono } from "next/font/google";
import { getPublicBranding } from "@/lib/branding";
import { PwaRegister } from "@/components/pwa-register";
import "./globals.css";

/** PWA theme color (P4.4 / ADR-0075). */
export const viewport: Viewport = { themeColor: "#0b0f14" };

const display = Geist({
  subsets: ["latin", "cyrillic"],
  variable: "--font-display",
  display: "swap",
});

const ui = Onest({
  subsets: ["latin", "cyrillic"],
  variable: "--font-ui",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-mono",
  display: "swap",
});

// Branding-driven document metadata (P0.11 / ADR-0018). Resolved per-request
// from the default tenant's branding so the title/description aren't hardcoded.
export async function generateMetadata(): Promise<Metadata> {
  const { copy } = await getPublicBranding();
  return {
    title: {
      default: copy.metaTitle,
      template: "%s — CMC",
    },
    description: copy.metaDescription,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { localeDefault } = await getPublicBranding();
  return (
    <html
      lang={localeDefault}
      className={`dark ${display.variable} ${ui.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen antialiased">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
