import { Module } from "@nestjs/common";
import { BrandingController } from "./branding.controller";
import { BrandingService } from "./branding.service";

/**
 * BrandingService injects TenantDatabaseService + TenantContextService (both
 * global), so no extra imports are needed here.
 */
@Module({
  controllers: [BrandingController],
  providers: [BrandingService],
})
export class BrandingModule {}
