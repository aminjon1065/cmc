import { loadConfig } from "../../src/config/configuration";

/**
 * Config validation guards (P0.10 / ADR-0017).
 *
 * Pure `loadConfig()` tests — no app boot, no infra. They live under
 * test/e2e/ only because that's the suite's single jest project; they touch
 * nothing external.
 *
 * The headline regression: compose / k8s commonly pass `VAR=` (empty string)
 * to mean "unset". An `emptyAsUndefined()`-wrapped optional var must collapse
 * empty / whitespace to `undefined` so an explicitly-blank env var never reaches
 * the wrapped validator and crashes boot.
 */
describe("loadConfig env validation", () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    // Start from a minimal valid env each time.
    process.env = {
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      S3_ENDPOINT: "http://localhost:9000",
      S3_ACCESS_KEY: "k",
      S3_SECRET_KEY: "s",
      S3_BUCKET_FILES: "cmc-files",
      JWT_SECRET: "test-jwt-secret-at-least-32-characters-long!!",
    };
  });

  afterAll(() => {
    process.env = ORIGINAL;
  });

  it("treats an empty emptyAsUndefined() var as unset (does not throw)", () => {
    process.env.VAULT_TOKEN = "";
    const cfg = loadConfig();
    expect(cfg.VAULT_TOKEN).toBeUndefined();
  });

  it("treats a whitespace-only value as unset", () => {
    process.env.VAULT_TOKEN = "   ";
    const cfg = loadConfig();
    expect(cfg.VAULT_TOKEN).toBeUndefined();
  });

  it("honours a real value", () => {
    process.env.VAULT_TOKEN = "s.abc123";
    const cfg = loadConfig();
    expect(cfg.VAULT_TOKEN).toBe("s.abc123");
  });

  it("still rejects a malformed required URL", () => {
    process.env.DATABASE_URL = "not-a-url";
    expect(() => loadConfig()).toThrow(/Invalid environment configuration/);
  });
});
