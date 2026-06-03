import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IMPORT_QUEUE, createImportQueue } from "./import.queue";
import { ImportService } from "./import.service";
import { ImportController } from "./import.controller";
import { ImportWorker } from "./import.worker";

/**
 * Bulk data-import plane (P3.11 / ADR-0056). The queue is real (BullMQ) only
 * when `IMPORTS_ENABLED`, else a noop; the worker (skipped in tests) consumes
 * it. ImportService uses TenantDatabaseService + StorageService + AuditService +
 * RbacService (all @Global). Tests drive `ImportService.runJob` directly.
 */
@Module({
  controllers: [ImportController],
  providers: [
    {
      provide: IMPORT_QUEUE,
      inject: [ConfigService],
      useFactory: createImportQueue,
    },
    ImportService,
    ImportWorker,
  ],
  exports: [ImportService],
})
export class ImportsModule {}
