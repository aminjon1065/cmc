import { Global, Module } from "@nestjs/common";
import { RealtimeGateway } from "./realtime.gateway";
import { RealtimeRegistryService } from "./realtime-registry.service";
import { RealtimeFanoutSubscriber } from "./realtime-fanout.subscriber";
import { WsAuthService } from "./ws-auth.service";
import { RealtimeController } from "./realtime.controller";

/**
 * Realtime plane (P2.3 / ADR-0035). Global so the registry is injectable
 * anywhere. The gateway attaches to the HTTP server's `upgrade` event at
 * bootstrap (gated by `REALTIME_ENABLED`); auth reuses the global `JwtService`
 * + session check and resolves P1.1 permissions per connection. The fan-out
 * subscriber (P2.3b) bridges the NATS event plane to subscribed sockets.
 */
@Global()
@Module({
  controllers: [RealtimeController],
  providers: [
    RealtimeGateway,
    RealtimeRegistryService,
    RealtimeFanoutSubscriber,
    WsAuthService,
  ],
  exports: [RealtimeRegistryService],
})
export class RealtimeModule {}
