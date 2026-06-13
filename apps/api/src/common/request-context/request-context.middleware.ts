import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { RequestContextService } from "./request-context.service";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEADER = "x-request-id";

/**
 * The first middleware in the chain. For every request:
 *
 *   1. If the inbound `X-Request-Id` header is present AND has UUID shape,
 *      honour it. Otherwise mint a fresh UUID v4.
 *   2. Echo it back as `X-Request-Id`.
 *   3. Open the request-context ALS scope so log lines + audit rows carry the
 *      same `request_id` (ADR-0010).
 *
 * `request_id` is the correlation id across logs and audit. Distributed tracing
 * (OpenTelemetry / Tempo) was removed in ADR-0080 — observability is structured
 * logs + Prometheus + health probes. The UUID-shape gate on the inbound id is a
 * security guard against log / audit injection.
 *
 * Must run BEFORE `TenantContextMiddleware` so JWT-verification failures
 * (durable-audit path) still carry the request id.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly requestContext: RequestContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header(HEADER);
    const requestId = inbound && UUID_RE.test(inbound) ? inbound : randomUUID();

    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    this.requestContext.run({ requestId }, () => next());
  }
}
