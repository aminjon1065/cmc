// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("node:path");

/** @type {import("jest").Config} */
module.exports = {
  rootDir: path.resolve(__dirname, ".."),
  testEnvironment: "node",
  testRegex: "test/e2e/.*\\.e2e-spec\\.ts$",
  transform: { "^.+\\.ts$": "ts-jest" },
  // Compiled workspace packages ship as plain JS — don't re-transpile.
  transformIgnorePatterns: [
    "/node_modules/",
    "<rootDir>/../../packages/[^/]+/dist/",
  ],
  moduleFileExtensions: ["ts", "js", "json"],
  // Tests touch real Postgres + run real argon2 verifies. 15s default is
  // tight under load; 30s gives margin without hiding genuine hangs.
  testTimeout: 30_000,
  // Load the .env.test bootstrap before each worker imports anything.
  setupFiles: [path.resolve(__dirname, "env.ts")],
  // One global setup that creates cmc_test, applies migrations, grants
  // cmc_app. Runs once before any worker starts.
  globalSetup: path.resolve(__dirname, "global-setup.ts"),
  // Run e2e suites serially — they share one Postgres database and
  // truncate between cases.
  maxWorkers: 1,
};
