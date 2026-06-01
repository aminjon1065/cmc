import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  trace,
  context as otelContext,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  isSpanContextValid,
  type Span,
} from "@opentelemetry/api";
import { RequestContextService } from "./request-context.service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEADER = "x-request-id";

/**
 * The first middleware in the chain. For every request:
 *
 *   1. If the inbound `X-Request-Id` header is present AND has UUID
 *      shape, honour it. Otherwise mint a fresh UUID v4.
 *   2. Echo it back as `X-Request-Id`.
 *   3. Open the request-context ALS scope.
 *   4. Ensure an OTEL span is active and stamp its trace id into the ALS
 *      + echo it as `X-Trace-Id` (P0.6 / ADR-0013), so logs + audit rows
 *      carry trace_id and ops can pivot into Tempo.
 *
 * Span sourcing (the load-bearing detail):
 *   - In production the HTTP auto-instrumentation has already created a
 *     server span by the time this runs; we read it and move on.
 *   - When no span is active — auto-instrumentation didn't patch `http`
 *     (e.g. under jest, which loads modules through its own runtime so
 *     require-in-the-middle never fires; or a deployment that disabled
 *     the http instrumentation) — we extract the inbound W3C trace
 *     context and start our own SERVER span. This makes trace_id flow
 *     and honours an inbound `traceparent` regardless of whether
 *     auto-instrumentation succeeded, and lets the e2e suite assert the
 *     behaviour deterministically. Uses only the OTEL *API* (context /
 *     propagation / trace), which `sdk.start()` wires up independently of
 *     module patching.
 *
 * The UUID-shape gate on inbound request-id is a security guard against
 * log / audit injection.
 *
 * Must run BEFORE `TenantContextMiddleware` so JWT-verification failures
 * (durable-audit path) still carry both ids.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly tracer = trace.getTracer("cmc-http");

  constructor(private readonly requestContext: RequestContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header(HEADER);
    const requestId = inbound && UUID_RE.test(inbound) ? inbound : randomUUID();

    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    this.requestContext.run({ requestId }, () => {
      const active = trace.getActiveSpan();
      if (active) {
        // Auto-instrumentation already created the server span.
        this.stamp(active, res);
        next();
        return;
      }

      // No active span — create a fallback SERVER span from the inbound
      // W3C context so trace_id still propagates.
      const parentCtx = propagation.extract(ROOT_CONTEXT, req.headers);
      const span = this.tracer.startSpan(
        `${req.method} ${req.path}`,
        { kind: SpanKind.SERVER },
        parentCtx,
      );
      // End the span exactly once when the response settles. `finish`
      // (normal completion) and `close` (client aborted / socket closed)
      // can both fire; the guard prevents a double-end ("you can only
      // call end() on a span once").
      let ended = false;
      const endOnce = () => {
        if (ended) return;
        ended = true;
        span.end();
      };
      res.on("finish", endOnce);
      res.on("close", endOnce);

      otelContext.with(trace.setSpan(parentCtx, span), () => {
        this.stamp(span, res);
        next();
      });
    });
  }

  /** Copy a span's trace id into the ALS + the X-Trace-Id response header. */
  private stamp(span: Span, res: Response): void {
    const spanContext = span.spanContext();
    if (isSpanContextValid(spanContext)) {
      this.requestContext.setTraceId(spanContext.traceId);
      res.setHeader("X-Trace-Id", spanContext.traceId);
    }
  }
}
