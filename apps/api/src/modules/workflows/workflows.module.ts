import { Module } from "@nestjs/common";
import { WorkflowsService } from "./workflows.service";
import { WorkflowsController } from "./workflows.controller";

/**
 * Workflows module (P3.8 / ADR-0053). The visual-builder definition store.
 * WorkflowsService uses TenantDatabaseService + AuditService (@Global) and the
 * controller uses RbacService (@Global) via the authorize guard — no extra
 * imports. The interpreter + run engine arrive in P3.8b.
 */
@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
