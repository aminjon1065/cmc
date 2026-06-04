import { Module } from "@nestjs/common";
import { BackupStatusService } from "./backup-status.service";
import { BackupStatusController } from "./backup-status.controller";

/**
 * Backups / DR module (P5.DR / ADR-0074). Exposes the single-site
 * backup-freshness check. StorageService is @Global; no DB.
 */
@Module({
  providers: [BackupStatusService],
  controllers: [BackupStatusController],
  exports: [BackupStatusService],
})
export class BackupsModule {}
