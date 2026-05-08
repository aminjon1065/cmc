import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "../../config/configuration";
import { StorageService } from "./storage.service";
import { S3_INTERNAL, S3_PUBLIC } from "./storage.tokens";

function buildS3Client(
  config: ConfigService<AppConfig, true>,
  endpoint: string,
): S3Client {
  return new S3Client({
    endpoint,
    region: config.get("S3_REGION", { infer: true }),
    credentials: {
      accessKeyId: config.get("S3_ACCESS_KEY", { infer: true }),
      secretAccessKey: config.get("S3_SECRET_KEY", { infer: true }),
    },
    forcePathStyle: config.get("S3_FORCE_PATH_STYLE", { infer: true }),
  });
}

@Global()
@Module({
  providers: [
    {
      provide: S3_INTERNAL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        buildS3Client(config, config.get("S3_ENDPOINT", { infer: true })),
    },
    {
      provide: S3_PUBLIC,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        buildS3Client(
          config,
          config.get("S3_PUBLIC_ENDPOINT", { infer: true }) ??
            config.get("S3_ENDPOINT", { infer: true }),
        ),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
