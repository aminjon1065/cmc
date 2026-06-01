// Jest setup file: start OpenTelemetry in the test process so trace_id
// propagation can be exercised end-to-end (X-Trace-Id headers, trace_id
// on audit rows). Listed AFTER env.ts in `setupFiles` so `.env.test`
// (which sets OTEL_ENABLED=true, no exporter) is loaded first.
//
// Importing the production tracing module guarantees the test process
// instruments http/express/nestjs exactly the way `main.ts` does, rather
// than a divergent test-only setup.
import "../src/tracing";
