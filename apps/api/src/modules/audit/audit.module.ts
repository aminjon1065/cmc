import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "./audit.service";
import { AuditChainService } from "./audit-chain.service";
import { AuditExportService } from "./audit-export.service";
import { AuditController } from "./audit.controller";
import { AUDIT_EXPORT_SINK, createAuditExportSink } from "./audit-export.sink";

@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditChainService,
    AuditExportService,
    {
      provide: AUDIT_EXPORT_SINK,
      inject: [ConfigService],
      useFactory: createAuditExportSink,
    },
  ],
  exports: [AuditService, AuditChainService, AuditExportService],
})
export class AuditModule {}
