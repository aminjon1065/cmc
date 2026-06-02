import { Module } from "@nestjs/common";
import { WorkflowsService } from "./workflows.service";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowEventConsumer } from "./workflow-event.consumer";
import { WorkflowEventSubscriber } from "./workflow-event.subscriber";

/**
 * Workflows module (P3.8 / ADR-0053). The visual-builder definition store +
 * interpreter run engine (P3.8b). WorkflowsService uses TenantDatabaseService +
 * AuditService + TEMPORAL_CLIENT (@Global) and the controller uses RbacService
 * (@Global) via the authorize guard. The event consumer/subscriber (P3.8c)
 * auto-start workflows from domain events (EventDedupService is @Global).
 */
@Module({
  controllers: [WorkflowsController],
  providers: [
    WorkflowsService,
    WorkflowEventConsumer,
    WorkflowEventSubscriber,
  ],
  exports: [WorkflowsService, WorkflowEventConsumer],
})
export class WorkflowsModule {}
