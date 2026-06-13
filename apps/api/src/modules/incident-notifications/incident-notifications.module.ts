import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { IncidentNotificationsListener } from "./incident-notifications.listener";

/**
 * Leaf module bridging incident events → notifications (ADR-0032). Listens to
 * the in-process domain events emitted by IncidentsService (ADR-0080) via
 * `@OnEvent` and dispatches notifications. Imports only NotificationsModule —
 * the event carries the incident detail, so there is no dependency on
 * IncidentsService (and no module cycle).
 */
@Module({
  imports: [NotificationsModule],
  providers: [IncidentNotificationsListener],
})
export class IncidentNotificationsModule {}
