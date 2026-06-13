import { Global, Module } from "@nestjs/common";
import { OutboxService } from "./outbox.service";
import { RelayService } from "./relay.service";
import { EventDedupService } from "./event-dedup.service";
import { EventsController } from "./events.controller";
import { EVENT_PUBLISHER, createEventPublisher } from "./event-publisher";

/**
 * Event plane (P2.1 / ADR-0031; ADR-0080). Global so any domain service can
 * inject `OutboxService` and append events inside its own transaction. The
 * transactional outbox + relay remain as the durability seam but are **off by
 * default** — the publisher is the noop, so the relay idles. Cross-module
 * reactions run in-process via the Nest EventEmitter (see `domain-events.ts`).
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
      useFactory: createEventPublisher,
    },
  ],
  exports: [OutboxService, RelayService, EventDedupService],
})
export class EventsModule {}
