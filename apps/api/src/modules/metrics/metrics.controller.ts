import { Controller, Get, Header, Res } from "@nestjs/common";
import type { Response } from "express";
import { MetricsService } from "./metrics.service";

/**
 * Prometheus scrape endpoint (P0.7 / ADR-0014).
 *
 * Anonymous + unversioned by design: Prometheus scrapes `GET /metrics`
 * with no auth, exactly like `GET /health`. It is NOT under the `/v1`
 * surface (P1.9) because the scrape contract is an operational concern,
 * not part of the public API.
 *
 * Exposure posture: open on the app, to be network-restricted at the
 * reverse proxy (P0.9 Caddy) / not published to the public listener in
 * production — same treatment as the Postgres/Redis ports. Documented in
 * ADR-0014.
 */
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader("Content-Type", this.metrics.contentType());
    res.send(await this.metrics.render());
  }
}
