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
): Params {
  const isProd = nodeEnv === "production";

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
          return url === "/health" || url === "/health/ready";
        },
      },
      // Per-request structured fields read at log time so each line
      // carries the *current* request's tenant + user scope.
      customProps: () => {
        const reqCtx = requestContext.getCurrent();
        const tenantCtx = tenantContext.getCurrent();
        return {
          requestId: reqCtx?.requestId,
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
      transport: isProd
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              singleLine: true,
              translateTime: "SYS:HH:MM:ss.l",
              // `requestId` is the most-clicked field when chasing a
              // bug; pino-pretty doesn't surface customProps prominently
              // by default, so we ignore the default messageFormat and
              // include them via messageFormat below.
              messageFormat:
                "[{requestId}] {context} {msg}",
              ignore: "pid,hostname,req,res,responseTime,requestId,context",
            },
          },
    },
  };
}
