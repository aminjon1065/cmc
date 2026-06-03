import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { CollabService } from "./collab.service";
import { CollabServer } from "./collab.server";
import { CollabController } from "./collab.controller";

/**
 * Realtime-collaboration module (P4.1 / ADR-0060). CollabService (auth +
 * ticket minting + Yjs↔wiki persistence) uses TenantDatabaseService +
 * RbacService + Redis (all @Global) + its own JwtService (to verify collaborator
 * JWTs at the WS handshake; the browser path uses single-use tickets instead).
 * CollabController mints those tickets; CollabServer boots the gated Hocuspocus
 * WS server.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        secret: config.get("JWT_SECRET", { infer: true }),
      }),
    }),
  ],
  controllers: [CollabController],
  providers: [CollabService, CollabServer],
  exports: [CollabService],
})
export class CollabModule {}
