/**
 * OpenTelemetry tracing bootstrap (P0.6 / ADR-0013).
 *
 * MUST be imported before any instrumented library (http, express,
 * @nestjs/core, @aws-sdk/*, ioredis). The auto-instrumentations patch
 * those modules at require time, so this file is the very first import
 * in `main.ts` and is loaded as the first jest `setupFile` in tests.
 *
 * Exporter selection (in priority order):
 *   1. OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT set → OTLP/HTTP, batched.
 *      This is what P1.8 (Tempo) will configure.
 *   2. OTEL_TRACES_CONSOLE=true → ConsoleSpanExporter (dev/debug).
 *   3. neither → spans are still created (so trace_id flows into logs +
 *      audit and W3C context propagates) but nothing is exported, and no
 *      connection-refused noise is produced. This is the default dev
 *      posture until a collector exists.
 *
 * Kill switch: OTEL_ENABLED=false skips the SDK entirely (no spans).
 *
 * Sampling, resource attributes beyond service.*, and propagators honour
 * the standard OTEL_* environment variables via NodeSDK's own env
 * parsing — no code change needed to tune them in an operator's env.
 */
import { config as loadDotenv } from "dotenv";

// This file runs before main.ts's own dotenv call (and, in tests, before
// env.ts has necessarily run for THIS module's reads), so load .env here
// too. dotenv does not override already-set vars, so a test harness that
// loaded .env.test first still wins.
loadDotenv();

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

// Guard against double-start. In jest, each test file resets the module
// registry but shares one worker process; re-running NodeSDK.start would
// warn "tracer provider already registered". Persist the flag on
// globalThis so it survives module-registry resets.
const GLOBAL_FLAG = "__cmcTracingStarted";

function isEnabled(): boolean {
  // Default ON. The exporter (not span creation) is what's gated on
  // configuration, so "on with no collector" is a safe, quiet default.
  return (process.env.OTEL_ENABLED ?? "true").toLowerCase() !== "false";
}

/**
 * A span processor that exports nothing. Used when no collector is
 * configured so the SDK still initializes fully — instrumentations
 * registered, spans created, W3C context propagated, trace_id available
 * to logs + audit — but no spans leave the process and there is no
 * default-OTLP fallback (which would spew connection errors in dev/CI).
 *
 * NOTE: we deliberately do NOT set `OTEL_TRACES_EXPORTER=none` to achieve
 * this — in @opentelemetry/sdk-node that value skips SDK initialization
 * entirely (no instrumentations, no spans), which would defeat the whole
 * "trace_id still flows with no collector" design goal.
 */
const NOOP_SPAN_PROCESSOR: SpanProcessor = {
  onStart() {},
  onEnd() {},
  forceFlush() {
    return Promise.resolve();
  },
  shutdown() {
    return Promise.resolve();
  },
};

function buildSpanProcessors(): SpanProcessor[] {
  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (otlpEndpoint) {
    // OTLPTraceExporter reads OTEL_EXPORTER_OTLP_* from env itself
    // (endpoint, headers, protocol), so we don't hardcode the URL.
    return [new BatchSpanProcessor(new OTLPTraceExporter())];
  }

  if ((process.env.OTEL_TRACES_CONSOLE ?? "false").toLowerCase() === "true") {
    return [new SimpleSpanProcessor(new ConsoleSpanExporter())];
  }

  // No collector configured: keep the SDK fully initialized but export
  // nothing. Passing an explicit (non-empty) spanProcessors array also
  // means NodeSDK never consults OTEL_TRACES_EXPORTER / never defaults to
  // localhost:4318.
  return [NOOP_SPAN_PROCESSOR];
}

export function startTracing(): void {
  if (!isEnabled()) return;
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_FLAG]) return;

  // Surface OTEL's own warnings/errors through its diag channel at WARN.
  // Without this, exporter/instrumentation problems are silent.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  // Always a non-empty array (real exporter, console, or the no-op
  // processor) — so NodeSDK never consults OTEL_TRACES_EXPORTER and never
  // falls back to its default localhost:4318 exporter.
  const spanProcessors = buildSpanProcessors();

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "cmc-api",
      [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || "0.0.0",
      "deployment.environment.name": process.env.NODE_ENV || "development",
    }),
    spanProcessors,
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs is extremely noisy and rarely useful; net/dns add little
        // signal over the http + db spans. Everything else
        // (http, express, nestjs-core, aws-sdk, ioredis, pg) stays on.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  });

  sdk.start();
  g[GLOBAL_FLAG] = true;

  // Flush + shut down on process exit so the last spans aren't lost.
  // Nest's enableShutdownHooks handles SIGTERM for the app; we hook the
  // SDK's own flush here independently.
  const shutdown = () => {
    sdk
      .shutdown()
      .catch((err: unknown) =>
        diag.error("OTEL shutdown error", err as Error),
      )
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// Side-effect start on import — this is the contract that makes
// `import "./tracing"` at the top of main.ts sufficient.
startTracing();
