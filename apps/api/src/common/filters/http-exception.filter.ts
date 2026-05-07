import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

/**
 * Uniform error response: RFC 7807-style problem+json body.
 * Unhandled errors are logged with their stack but the client only sees a
 * generic 500 message — no internal leakage.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

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
        timestamp: new Date().toISOString(),
      });
  }
}
