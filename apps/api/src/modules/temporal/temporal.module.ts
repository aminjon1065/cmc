import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TEMPORAL_CLIENT, createTemporalClient } from "./temporal-client";
import { CaseSlaScheduler } from "./case-sla.scheduler";
import { TemporalWorker } from "./temporal.worker";

/**
 * Durable workflows plane (P3.1 / ADR-0045). @Global so any domain module can
 * inject {@link CaseSlaScheduler} to start/cancel workflows. The client is real
 * (Temporal) only when `TEMPORAL_ENABLED`, else a noop; the in-process worker
 * (also gated) runs workflow + activity code.
 */
@Global()
@Module({
  providers: [
    {
      provide: TEMPORAL_CLIENT,
      inject: [ConfigService],
      useFactory: createTemporalClient,
    },
    CaseSlaScheduler,
    TemporalWorker,
  ],
  exports: [CaseSlaScheduler, TEMPORAL_CLIENT],
})
export class TemporalModule {}
