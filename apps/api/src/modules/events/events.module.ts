import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OutboxService } from "./outbox.service";
import { RelayService } from "./relay.service";
import { EventDedupService } from "./event-dedup.service";
import { EventsController } from "./events.controller";
import { EVENT_PUBLISHER, createEventPublisher } from "./event-publisher";

/**
 * Event plane (P2.1 / ADR-0031). Global so any domain service can inject
 * `OutboxService` and emit events inside its own transaction. The relay ships
 * unpublished outbox rows to NATS JetStream via the configured `EventPublisher`
 * (real NATS when `NATS_ENABLED`, else a noop).
 */
@Global()
@Module({
  controllers: [EventsController],
  providers: [
    OutboxService,
    RelayService,
    EventDedupService,
    {
      provide: EVENT_PUBLISHER,
      inject: [ConfigService],
      useFactory: createEventPublisher,
    },
  ],
  exports: [OutboxService, RelayService, EventDedupService],
})
export class EventsModule {}
