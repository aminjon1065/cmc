import { z } from "zod";

/**
 * Single-site disaster-recovery backup-freshness (P5.DR / ADR-0074). `GET
 * /v1/ops/backups/status` reports the newest Postgres dump (P0.5) in the backups
 * bucket and whether it is within the RPO window — the single-site analogue of
 * "multi-region resilience" (P5.7 active-active is N/A here).
 */
export const BackupStatusResponseSchema = z.object({
  bucket: z.string(),
  /** Number of backup objects found under the prefix. */
  count: z.number().int().nonnegative(),
  /** Newest backup object key, or null when none exist. */
  latestKey: z.string().nullable(),
  /** Newest backup's last-modified time (ISO), or null. */
  latestAt: z.string().datetime().nullable(),
  /** Age of the newest backup in hours (rounded), or null when none. */
  ageHours: z.number().nonnegative().nullable(),
  /** The recovery-point objective window (hours). */
  rpoHours: z.number().int().positive(),
  /** True when a backup exists and is younger than `rpoHours`. */
  fresh: z.boolean(),
});
export type BackupStatusResponse = z.infer<typeof BackupStatusResponseSchema>;
