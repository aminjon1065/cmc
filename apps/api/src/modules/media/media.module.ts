import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MEDIA_QUEUE, createMediaQueue } from "./media.queue";
import { MediaService } from "./media.service";
import { MediaController } from "./media.controller";
import { MediaWorker } from "./media.worker";

/**
 * Media management module (P4.5 / ADR-0063). MediaService uses
 * TenantDatabaseService + AuditService + StorageService (all @Global) + the
 * gated media-transcode queue. The queue is real (BullMQ) only when
 * `MEDIA_TRANSCODE_ENABLED`, else a noop; the worker (isTest-skipped) consumes
 * it and runs ffmpeg → HLS → S3.
 */
@Module({
  controllers: [MediaController],
  providers: [
    {
      provide: MEDIA_QUEUE,
      inject: [ConfigService],
      useFactory: createMediaQueue,
    },
    MediaService,
    MediaWorker,
  ],
  exports: [MediaService],
})
export class MediaModule {}
