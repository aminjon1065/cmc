/**
 * Loads `.env.test` (and `.env` as a fallback) into process.env before
 * tests import anything that calls `loadConfig()` or reads env at module
 * load time. Wired as `setupFiles` in jest-e2e.config.js so it runs in
 * every worker before the suite.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

const apiRoot = resolve(__dirname, "..");

loadDotenv({ path: resolve(apiRoot, ".env.test") });
loadDotenv({ path: resolve(apiRoot, ".env") });
