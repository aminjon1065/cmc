import { loadConfig } from "../../src/config/configuration";

/**
 * Config validation guards (P0.10 / ADR-0017).
 *
 * Pure `loadConfig()` tests — no app boot, no infra. They live under
 * test/e2e/ only because that's the suite's single jest project; they touch
 * nothing external.
 *
 * The headline regression: compose / k8s commonly pass `VAR=` (empty string)
 * to mean "unset". An empty OTEL endpoint must NOT fail the `.url()` check and
 * crash boot — it must be treated as "no collector". This bit a containerised
 * deploy (the API restart-looped with "OTEL_EXPORTER_OTLP_ENDPOINT: Invalid
 * url") before the `emptyAsUndefined` preprocessor landed.
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

  it("accepts an empty OTEL_EXPORTER_OTLP_ENDPOINT as unset (does not throw)", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "";
    const cfg = loadConfig();
    expect(cfg.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it("accepts a whitespace-only OTLP endpoint as unset", () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "   ";
    const cfg = loadConfig();
    expect(cfg.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();
  });

  it("still honours a real OTLP endpoint URL", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://tempo:4318";
    const cfg = loadConfig();
    expect(cfg.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://tempo:4318");
  });

  it("still rejects a non-empty, malformed OTLP endpoint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "not-a-url";
    expect(() => loadConfig()).toThrow(/Invalid environment configuration/);
  });
});
