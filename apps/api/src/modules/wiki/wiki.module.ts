import { Module } from "@nestjs/common";
import { WikiService } from "./wiki.service";
import { WikiController } from "./wiki.controller";

/**
 * Wiki module (P3.10 / ADR-0055). Spaces + pages (ltree tree) + version
 * snapshots. WikiService uses TenantDatabaseService + AuditService (@Global);
 * the controller uses RbacService (@Global) via the authorize guard. Comments
 * land in P3.10b.
 */
@Module({
  controllers: [WikiController],
  providers: [WikiService],
  exports: [WikiService],
})
export class WikiModule {}
