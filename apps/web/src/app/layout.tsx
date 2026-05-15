import type { Metadata } from "next";
import { Geist, Onest, JetBrains_Mono } from "next/font/google";
import "./globals.css";

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

export const metadata: Metadata = {
  title: {
    default: "CMC · Operational Intelligence Platform",
    template: "%s — CMC",
  },
  description:
    "Crisis Management Center · Committee of Emergency Situations and Civil Defense of Tajikistan",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${display.variable} ${ui.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
