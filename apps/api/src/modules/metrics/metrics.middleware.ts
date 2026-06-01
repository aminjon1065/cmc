import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { MetricsService } from "./metrics.service";

/**
 * Times every HTTP request and records it into the RED histogram on
 * response `finish` (P0.7 / ADR-0014).
 *
 * Applied FIRST in the middleware chain so the timer brackets the whole
 * request — including request-context + tenant-context setup.
 *
 * Two Express-request fields matter here, and the distinction is
 * load-bearing:
 *
 *   - `req.originalUrl` — the FULL request path, set once by Express and
 *     never rewritten. We use it for the exclusion check. (NestJS mounts
 *     consumer middleware on an internal sub-router that rewrites
 *     `req.url` / `req.path` to be relative to the mount — so reading
 *     `req.path` here yields "/" and an exclusion based on it silently
 *     never matches. `req.originalUrl` is immune to that rewrite.)
 *   - `req.route?.path` — the MATCHED route pattern (e.g.
 *     `/auth/sessions/:id`), populated only after routing resolves, which
 *     is why we read it inside the `finish` callback. Using the pattern
 *     (not the concrete URL) keeps high-cardinality ids out of the label.
 *
 * `/metrics` and `/health*` are excluded so the endpoints that exist to
 * observe the system don't pollute the system's own RED signal.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startNs = process.hrtime.bigint();

    res.once("finish", () => {
      // originalUrl is the full, un-rewritten path (+ query). Strip the
      // query string before matching. (`?? ""` keeps the type `string` —
      // String.split can be typed to include undefined under strict TS.)
      const urlPath = (req.originalUrl || req.url || "").split("?")[0] ?? "";
      if (
        urlPath === "/metrics" ||
        urlPath === "/health" ||
        urlPath.startsWith("/health/")
      ) {
        return;
      }

      const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      // req.route is set during dispatch; present here because `finish`
      // fires after the handler ran. Undefined for unmatched routes
      // (404s, scanners) → a single `<unmatched>` bucket so a bot sweep
      // can't explode label cardinality.
      const route =
        (req.route as { path?: string } | undefined)?.path ?? "<unmatched>";
      this.metrics.observeHttp({
        method: req.method,
        route,
        statusCode: res.statusCode,
        durationSec,
      });
    });

    next();
  }
}
