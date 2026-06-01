import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained server bundle for the Docker runtime (P0.10 / ADR-0017):
  // Next traces exactly the files the server needs into `.next/standalone`,
  // so the runtime image carries no full node_modules.
  output: "standalone",
  // In a pnpm monorepo the files to trace live above apps/web (the hoisted
  // node_modules + the workspace packages). Point tracing at the repo root so
  // `@cmc/contracts` and its transitive deps are included in the bundle.
  outputFileTracingRoot: resolve(here, "../.."),
  // Transpile our internal workspace packages so Next.js compiles their TS sources.
  transpilePackages: ["@cmc/contracts"],
  typedRoutes: true,
  // Source of API base URL is centralised here so every fetch goes through one place.
  env: {
    NEXT_PUBLIC_API_BASE_URL:
      process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001",
  },
};

export default nextConfig;
