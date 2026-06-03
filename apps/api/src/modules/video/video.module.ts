import { Module } from "@nestjs/common";
import { VideoService } from "./video.service";
import { VideoController } from "./video.controller";

/**
 * Video conferencing module (P4.2 / ADR-0061). VideoService uses
 * TenantDatabaseService + AuditService + RbacService + ConfigService (all
 * @Global) and dynamic-imports `livekit-server-sdk` to mint room-scoped join
 * tokens (gated lazy seam). The SFU (LiveKit) + TURN (coturn) run as gated dev
 * containers; tests exercise the minted token directly (no real WebRTC).
 */
@Module({
  controllers: [VideoController],
  providers: [VideoService],
  exports: [VideoService],
})
export class VideoModule {}
