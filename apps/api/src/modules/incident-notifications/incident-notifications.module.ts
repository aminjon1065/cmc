import { Module } from "@nestjs/common";
import { IncidentsModule } from "../incidents/incidents.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { IncidentNotificationsConsumer } from "./incident-notifications.consumer";
import { IncidentNotificationsSubscriber } from "./incident-notifications.subscriber";

/**
 * Leaf module bridging incident events → notifications (P2.4 / ADR-0032).
 * Imports both domain modules (avoiding a cycle — neither imports this);
 * `EventDedupService` comes from the global EventsModule. The subscriber drives
 * the consumer from a durable JetStream consumer when `NATS_ENABLED`.
 */
@Module({
  imports: [IncidentsModule, NotificationsModule],
  providers: [IncidentNotificationsConsumer, IncidentNotificationsSubscriber],
  exports: [IncidentNotificationsConsumer],
})
export class IncidentNotificationsModule {}
