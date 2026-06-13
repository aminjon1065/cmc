import { Global, Module } from "@nestjs/common";
import { RealtimeGateway } from "./realtime.gateway";
import { RealtimeRegistryService } from "./realtime-registry.service";
import { RealtimeFanoutListener } from "./realtime-fanout.listener";
import { WsAuthService } from "./ws-auth.service";
import { RealtimeController } from "./realtime.controller";

/**
 * Realtime plane (P2.3 / ADR-0035). Global so the registry is injectable
 * anywhere. The gateway attaches to the HTTP server's `upgrade` event at
 * bootstrap (gated by `REALTIME_ENABLED`); auth reuses the global `JwtService`
 * + session check and resolves P1.1 permissions per connection. The fan-out
 * listener (ADR-0080) bridges in-process domain events to subscribed sockets.
 */
@Global()
@Module({
  controllers: [RealtimeController],
  providers: [
    RealtimeGateway,
    RealtimeRegistryService,
    RealtimeFanoutListener,
    WsAuthService,
  ],
  exports: [RealtimeRegistryService],
})
export class RealtimeModule {}
