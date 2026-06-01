import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import type {
  EventRelayFlushResponse,
  EventRelayStatusResponse,
} from "@cmc/contracts";
import { RelayService } from "./relay.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";

/**
 * Outbox→NATS relay ops endpoints (P2.1b / ADR-0031). Gated on `tenant:manage`
 * — platform-level (pending count is cross-tenant); a superadmin gate is a
 * later refinement.
 */
@Controller("events/relay")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class EventsController {
  constructor(private readonly relay: RelayService) {}

  /** Relay status: publisher active, interval on, pending outbox rows, stream. */
  @Get("status")
  @Authorize("tenant:manage")
  async status(): Promise<EventRelayStatusResponse> {
    return this.relay.status();
  }

  /** Force a relay pass — publish the next batch of unpublished events. */
  @Post("flush")
  @HttpCode(HttpStatus.OK)
  @Authorize("tenant:manage")
  async flush(): Promise<EventRelayFlushResponse> {
    return this.relay.flush();
  }
}
