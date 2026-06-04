import type { Metadata, Viewport } from "next";
import { Geist, Onest, JetBrains_Mono } from "next/font/google";
import { getPublicBranding } from "@/lib/branding";
import { PwaRegister } from "@/components/pwa-register";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { cookies } from "next/headers";
import { THEME_COOKIE, explicitDark } from "@/lib/theme";
import "./globals.css";

/** Browser UI theme color — light is the default theme (ADR-0077). */
export const viewport: Viewport = { themeColor: "#f0f3f7" };

/**
 * Pre-paint theme script (ADR-0078): applies the `.dark` class from the `theme`
 * cookie before first paint, resolving `system` via `matchMedia` so there's no
 * flash for system/dark users. The server also sets the class for an explicit
 * `dark` cookie below (zero-flash for that common case); this reconciles the
 * rest.
 */
const THEME_INIT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )theme=([^;]+)/);var t=m?decodeURIComponent(m[1]):'light';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

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
  const locale = await getLocale();
  const messages = await getMessages();
  const dark = explicitDark((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang={locale}
      className={`${dark ? "dark " : ""}${display.variable} ${ui.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
          <PwaRegister />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
