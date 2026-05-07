import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
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
