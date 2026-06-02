import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PREVIEW_QUEUE, createPreviewQueue } from "./preview.queue";
import { PreviewService } from "./preview.service";
import { PreviewWorker } from "./preview.worker";

/**
 * Previews plane (P2.13 / ADR-0043). @Global so DocumentsService can inject
 * `PreviewService` to enqueue on finalize. The queue is real (BullMQ) only when
 * `PREVIEWS_ENABLED`, else a noop; the worker (P2.13b) consumes it.
 */
@Global()
@Module({
  providers: [
    {
      provide: PREVIEW_QUEUE,
      inject: [ConfigService],
      useFactory: createPreviewQueue,
    },
    PreviewService,
    PreviewWorker,
  ],
  exports: [PreviewService, PREVIEW_QUEUE],
})
export class PreviewsModule {}
