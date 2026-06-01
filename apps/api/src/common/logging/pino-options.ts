import type { Params } from "nestjs-pino";
import type { IncomingMessage } from "node:http";
import { TenantContextService } from "../tenant-context/tenant-context.service";
import { RequestContextService } from "../request-context/request-context.service";

/**
 * Centralised pino / nestjs-pino configuration.
 *
 * Built as a factory rather than a constant because (a) it needs to
 * read NODE_ENV / LOG_LEVEL at boot and (b) the `mixin` reads the
 * ALS-backed RequestContextService + TenantContextService instances
 * that NestJS owns the lifecycle of. The factory is invoked from
 * `LoggerModule.forRootAsync(...)` in AppModule.
 *
 * Design choices:
 *
 *   - JSON output in production for log-aggregator ingestion.
 *     pino-pretty in non-prod for human readability.
 *   - `genReqId` honours `req.requestId` (set by
 *     RequestContextMiddleware), so pino-http's request log lines
 *     carry the *same* id that audit-log rows do.
 *   - `redact` strips known-sensitive fields. Email is kept visible
 *     for incident-investigation pivot. Documented in ADR-0010.
 *   - `serializers.req` returns a minimal allowlist of headers so a
 *     careless `req.headers` log doesn't dump Authorization / Cookie.
 *   - `customProps` is the per-request enrichment hook; we read the
 *     two ALS contexts at log time so each line carries the *current*
 *     tenant + request scope.
 */
export function buildPinoOptions(
  nodeEnv: string,
  logLevel: string,
  requestContext: RequestContextService,
  tenantContext: TenantContextService,
  lokiUrl?: string,
): Params {
  const isProd = nodeEnv === "production";
  const transport = buildTransport(isProd, logLevel, nodeEnv, lokiUrl);

  return {
    pinoHttp: {
      level: logLevel,
      // The seed of every request log line — we use the request_id set
      // by middleware so the value matches what's in audit_log and
      // what's echoed on the response.
      genReqId: (req) => {
        const r = req as IncomingMessage & { requestId?: string };
        return r.requestId ?? "unset";
      },
      // Suppress request-completed lines for static / boring routes
      // (none today; placeholder for when /metrics, /favicon, etc. land).
      autoLogging: {
        ignore: (req) => {
          const url = (req as IncomingMessage).url ?? "";
          return (
            url === "/health" ||
            url === "/health/ready" ||
            url === "/metrics"
          );
        },
      },
      // Per-request structured fields read at log time so each line
      // carries the *current* request's tenant + user scope.
      customProps: () => {
        const reqCtx = requestContext.getCurrent();
        const tenantCtx = tenantContext.getCurrent();
        return {
          requestId: reqCtx?.requestId,
          // trace_id of the active OTEL span (P0.6 / ADR-0013) so every
          // log line joins to its distributed trace in Tempo/Grafana.
          ...(reqCtx?.traceId ? { traceId: reqCtx.traceId } : {}),
          ...(reqCtx?.correlationId
            ? { correlationId: reqCtx.correlationId }
            : {}),
          ...(tenantCtx
            ? {
                tenantId: tenantCtx.tenantId,
                tenantSlug: tenantCtx.tenantSlug,
                userId: tenantCtx.userId,
              }
            : {}),
        };
      },
      // Minimal request serializer — allowlist of headers. Default
      // pino-http logs every header which leaks Authorization /
      // Cookie / X-Api-Key into stdout. We pick the small set that
      // actually helps debugging.
      serializers: {
        req: (req) => {
          // pino-http already exposes `req.id`, `req.method`, `req.url`
          // via its built-in shape. We replace the default headers
          // serializer to keep secrets out.
          const r = req as {
            id?: string;
            method?: string;
            url?: string;
            remoteAddress?: string;
            remotePort?: number;
            headers?: Record<string, string | string[] | undefined>;
          };
          return {
            id: r.id,
            method: r.method,
            url: r.url,
            remoteAddress: r.remoteAddress,
            remotePort: r.remotePort,
            headers: r.headers
              ? {
                  "user-agent": r.headers["user-agent"],
                  "x-forwarded-for": r.headers["x-forwarded-for"],
                  "x-request-id": r.headers["x-request-id"],
                  "content-type": r.headers["content-type"],
                  "content-length": r.headers["content-length"],
                }
              : undefined,
          };
        },
      },
      redact: {
        paths: [
          // Per-request headers (defensive — the custom req serializer
          // above already drops these, but a future `logger.info({req})`
          // call could include the raw req object).
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'req.headers["set-cookie"]',
          // Request body fields. pino-http does not log body by default;
          // this is a defense against future code that does.
          "req.body.password",
          "req.body.refreshToken",
          // Domain-side defensive paths — never appear in request bodies
          // today but guard against future code logging full DB rows.
          "password",
          "passwordHash",
          "password_hash",
          "refreshToken",
          "refresh_token_hash",
          "*.password",
          "*.passwordHash",
          "*.refreshToken",
        ],
        censor: "[REDACTED]",
        remove: false,
      },
      transport,
    },
  };
}

/** pino-pretty options for human-readable dev stdout. */
const PRETTY_OPTIONS = {
  singleLine: true,
  translateTime: "SYS:HH:MM:ss.l",
  // `requestId` is the most-clicked field when chasing a bug; pino-pretty
  // doesn't surface customProps prominently, so we render them via
  // messageFormat and drop them from the trailing key=val dump.
  messageFormat: "[{requestId}] {context} {msg}",
  ignore: "pid,hostname,req,res,responseTime,requestId,context",
};

/**
 * Build the pino transport (P1.7 / ADR-0025).
 *
 * Without `lokiUrl` the behaviour is UNCHANGED — dev streams through
 * pino-pretty, prod writes plain JSON to stdout (transport `undefined`). With
 * `lokiUrl`, logs fan out to BOTH stdout (pretty in dev / JSON in prod) AND
 * Loki via the pino-loki transport, so the host-run API's logs land in Grafana.
 *
 * Labels are STATIC + low-cardinality (`app`, `env`); high-cardinality fields
 * (requestId, tenantId, userId) stay inside the JSON log line and are queried
 * with LogQL `| json` — making them labels would blow up Loki's index.
 */
function buildTransport(
  isProd: boolean,
  logLevel: string,
  nodeEnv: string,
  lokiUrl?: string,
) {
  if (!lokiUrl) {
    return isProd
      ? undefined
      : { target: "pino-pretty", options: PRETTY_OPTIONS };
  }
  const lokiTarget = {
    target: "pino-loki",
    level: logLevel,
    options: {
      host: lokiUrl,
      batching: true,
      interval: 5,
      labels: { app: "cmc-api", env: nodeEnv },
      // A Loki outage must never crash or block the API.
      silenceErrors: true,
    },
  };
  const stdoutTarget = isProd
    ? { target: "pino/file", level: logLevel, options: { destination: 1 } }
    : { target: "pino-pretty", level: logLevel, options: PRETTY_OPTIONS };
  return { targets: [stdoutTarget, lokiTarget] };
}
