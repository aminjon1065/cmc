import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { RateLimitExceededError } from "../rate-limit/rate-limit.error";

/**
 * Per RFC 7807 we surface the request_id as a top-level field on every
 * problem+json response so the client / on-call can read it from the
 * body in addition to the `X-Request-Id` response header (some HTTP
 * clients hide headers in their error UI).
 *
 * Reads from `req.requestId` (set by `RequestContextMiddleware`) rather
 * than the ALS service so the filter does not have to be DI-aware.
 */
function pickRequestId(request: Request): string | undefined {
  return request.requestId;
}

/**
 * Uniform error response: RFC 7807-style problem+json body.
 * Unhandled errors are logged with their stack but the client only sees a
 * generic 500 message — no internal leakage.
 *
 * Three branches:
 *   1. `RateLimitExceededError` → 429 + `Retry-After` header + problem+json
 *      body with `limit_name` so the client can distinguish per-IP vs
 *      per-email breaches.
 *   2. NestJS `HttpException` (4xx/5xx with carrier intent) → status from
 *      the exception; body from its `getResponse()`.
 *   3. Anything else → 500 with the stack logged and the client gets a
 *      generic "Internal Server Error" — never the underlying message.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = pickRequestId(request);

    // 1. Rate-limit breach — uniform 429 with Retry-After.
    if (exception instanceof RateLimitExceededError) {
      const retryAfter = Math.max(1, Math.ceil(exception.retryAfterSec));
      response
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .setHeader("Retry-After", String(retryAfter))
        .type("application/problem+json")
        .json({
          type: "about:blank",
          title: "Too Many Requests",
          status: HttpStatus.TOO_MANY_REQUESTS,
          detail: "Rate limit exceeded. Retry after the indicated delay.",
          // Surface enough metadata for the client to render a helpful
          // message — never the raw Redis key or the hashed email.
          limit_name: exception.limitName,
          retry_after_sec: retryAfter,
          instance: request.url,
          ...(requestId ? { request_id: requestId } : {}),
          timestamp: new Date().toISOString(),
        });
      return;
    }

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    let title = "Internal Server Error";
    let detail: string | undefined;

    if (isHttp) {
      const res = exception.getResponse();
      if (typeof res === "string") {
        title = res;
      } else if (typeof res === "object" && res !== null) {
        const r = res as { message?: unknown; error?: unknown };
        title = (typeof r.error === "string" && r.error) || title;
        detail = Array.isArray(r.message)
          ? r.message.join(", ")
          : typeof r.message === "string"
            ? r.message
            : undefined;
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception.stack,
      );
    } else {
      this.logger.error(
        `Unhandled non-Error exception on ${request.method} ${request.url}`,
        JSON.stringify(exception),
      );
    }

    response
      .status(status)
      .type("application/problem+json")
      .json({
        type: "about:blank",
        title,
        status,
        ...(detail ? { detail } : {}),
        instance: request.url,
        ...(requestId ? { request_id: requestId } : {}),
        timestamp: new Date().toISOString(),
      });
  }
}
