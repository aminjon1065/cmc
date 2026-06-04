import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { BackupStatusResponse } from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import { StorageService } from "../storage/storage.service";

/**
 * Single-site DR backup-freshness check (P5.DR / ADR-0074). Lists the nightly
 * Postgres dumps (P0.5 writes `postgres/…/*.dump` into the backups bucket),
 * finds the newest by last-modified, and reports whether it is within the RPO
 * window. The single-site analogue of multi-region resilience (P5.7 N/A): you
 * can't fail over to a second site, so the operational guarantee is "a fresh,
 * restorable backup exists".
 */
@Injectable()
export class BackupStatusService {
  private readonly bucket: string;
  private readonly rpoHours: number;

  constructor(
    private readonly storage: StorageService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.bucket = config.get("BACKUP_S3_BUCKET", { infer: true });
    this.rpoHours = config.get("BACKUP_RPO_HOURS", { infer: true });
  }

  async status(): Promise<BackupStatusResponse> {
    const objects = await this.storage.listObjects({
      bucket: this.bucket,
      prefix: "postgres/",
    });
    const dumps = objects.filter((o) => o.key.endsWith(".dump"));

    let latest: { key: string; at: Date } | null = null;
    for (const o of dumps) {
      if (o.lastModified && (!latest || o.lastModified > latest.at)) {
        latest = { key: o.key, at: o.lastModified };
      }
    }

    const ageHours = latest
      ? Math.max(0, Math.round((Date.now() - latest.at.getTime()) / 3_600_000))
      : null;
    const fresh = ageHours != null && ageHours <= this.rpoHours;

    return {
      bucket: this.bucket,
      count: dumps.length,
      latestKey: latest?.key ?? null,
      latestAt: latest?.at.toISOString() ?? null,
      ageHours,
      rpoHours: this.rpoHours,
      fresh,
    };
  }
}
