import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { schema } from "@cmc/db";
import type { MediaAsset } from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { MEDIA_QUEUE, type MediaQueue } from "./media.queue";
import type { AppConfig } from "../../config/configuration";

type Actor = { userId: string; tenantId: string };
type AssetRow = typeof schema.mediaAssets.$inferSelect;

/** Segment filename guard for the BFF proxy (no path traversal). */
const SEGMENT_RE = /^[A-Za-z0-9._-]+\.(ts|m4s|mp4|vtt)$/;

/**
 * Media management (P4.5 / ADR-0063). Owns `media_assets` + enqueues transcodes
 * onto the gated BullMQ seam; `transcode()` (run by the worker only) shells out
 * to ffmpeg to produce HLS in S3. The browser streams via the BFF proxy
 * (`getPlaylist` rewrites segment URIs through `getSegment`) — the access JWT
 * never reaches the player and access is RBAC-checked per request.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(MEDIA_QUEUE) private readonly queue: MediaQueue,
  ) {}

  private bucket(): string {
    return this.config.get("S3_BUCKET_FILES", { infer: true });
  }

  private toAsset(r: AssetRow): MediaAsset {
    return {
      id: r.id,
      documentId: r.documentId,
      kind: r.kind === "audio" ? "audio" : "video",
      status:
        r.status === "processing"
          ? "processing"
          : r.status === "ready"
            ? "ready"
            : r.status === "failed"
              ? "failed"
              : "pending",
      durationSec: r.durationSec ?? null,
      watermark: r.watermark ?? null,
      error: r.error ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async requestTranscode(
    actor: Actor,
    documentId: string,
    watermark?: string,
  ): Promise<MediaAsset> {
    const doc = await this.tenantDb.run(async (tx) => {
      const [d] = await tx
        .select({ id: schema.documents.id, mimeType: schema.documents.mimeType })
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.id, documentId),
            isNull(schema.documents.deletedAt),
          ),
        )
        .limit(1);
      return d ?? null;
    });
    if (!doc) throw new NotFoundException("Document not found");

    const kind = doc.mimeType.startsWith("audio/") ? "audio" : "video";
    const [row] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.mediaAssets)
        .values({
          tenantId: actor.tenantId,
          documentId,
          kind,
          status: "pending",
          watermark: watermark?.trim() ? watermark.trim() : null,
          createdBy: actor.userId,
        })
        .returning(),
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "media.transcode.requested",
      resourceType: "media_asset",
      resourceId: row!.id,
      outcome: "success",
      metadata: { documentId, queued: this.queue.active },
    });
    await this.queue.enqueue({ tenantId: actor.tenantId, assetId: row!.id });
    return this.toAsset(row!);
  }

  async listAssets(documentId?: string): Promise<MediaAsset[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.mediaAssets)
        .where(
          documentId
            ? eq(schema.mediaAssets.documentId, documentId)
            : undefined,
        )
        .orderBy(desc(schema.mediaAssets.createdAt)),
    );
    return rows.map((r) => this.toAsset(r));
  }

  private async getAssetRowOrFail(id: string): Promise<AssetRow> {
    const [row] = await this.tenantDb.run((tx) =>
      tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, id)).limit(1),
    );
    if (!row) throw new NotFoundException("Media asset not found");
    return row;
  }

  async getAsset(id: string): Promise<MediaAsset> {
    return this.toAsset(await this.getAssetRowOrFail(id));
  }

  /** HLS playlist with segment URIs rewritten through the BFF segment proxy. */
  async getPlaylist(id: string): Promise<string> {
    const row = await this.getAssetRowOrFail(id);
    if (row.status !== "ready" || !row.playlistKey) {
      throw new ConflictException("Media is not ready for streaming.");
    }
    const text = (
      await this.storage.getObjectBytes({ bucket: this.bucket(), key: row.playlistKey })
    ).toString("utf8");
    // Rewrite each segment URI (non-comment, non-empty line) → `seg/<name>` so
    // it resolves to this asset's segment proxy endpoint.
    return text
      .split("\n")
      .map((line) => {
        const t = line.trim();
        if (!t || t.startsWith("#")) return line;
        const name = t.split("/").pop() ?? t;
        return `seg/${name}`;
      })
      .join("\n");
  }

  /** Proxy one HLS segment's bytes from S3 (path-traversal guarded). */
  async getSegment(id: string, name: string): Promise<Buffer> {
    if (!SEGMENT_RE.test(name)) throw new BadRequestException("Invalid segment");
    const row = await this.getAssetRowOrFail(id);
    if (row.status !== "ready" || !row.playlistKey) {
      throw new ConflictException("Media is not ready for streaming.");
    }
    const dir = row.playlistKey.slice(0, row.playlistKey.lastIndexOf("/") + 1);
    return this.storage.getObjectBytes({ bucket: this.bucket(), key: `${dir}${name}` });
  }

  // ---------- worker path (only runs when MEDIA_TRANSCODE_ENABLED) ----------

  /**
   * Transcode a media asset's source document to HLS and upload to S3. Called by
   * the BullMQ worker; runs privileged (no request tenant context). Shells out
   * to `ffmpeg` (must be present in the worker image).
   */
  async transcode(tenantId: string, assetId: string): Promise<void> {
    const ctx = await this.tenantDb.runPrivileged(async (tx) => {
      const [asset] = await tx
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, assetId))
        .limit(1);
      if (!asset) return null;
      const [doc] = await tx
        .select({
          storageBucket: schema.documents.storageBucket,
          storageKey: schema.documents.storageKey,
        })
        .from(schema.documents)
        .where(eq(schema.documents.id, asset.documentId))
        .limit(1);
      return doc ? { asset, doc } : null;
    });
    if (!ctx) {
      this.logger.warn(`transcode: asset ${assetId} or its document is gone`);
      return;
    }

    const segSec = this.config.get("MEDIA_HLS_SEGMENT_SECONDS", { infer: true });
    const outPrefix = `media/${tenantId}/${assetId}`;
    const playlistKey = `${outPrefix}/index.m3u8`;
    const work = await mkdtemp(join(tmpdir(), `cmc-media-${assetId}-`));

    try {
      await this.tenantDb.runPrivileged((tx) =>
        tx
          .update(schema.mediaAssets)
          .set({ status: "processing", updatedAt: new Date() })
          .where(eq(schema.mediaAssets.id, assetId)),
      );

      const src = join(work, "source");
      await writeFile(
        src,
        await this.storage.getObjectBytes({
          bucket: ctx.doc.storageBucket,
          key: ctx.doc.storageKey,
        }),
      );

      // Optional text watermark burned into the video (P4.5c).
      const wmArgs: string[] = [];
      if (ctx.asset.watermark) {
        const font = this.config.get("MEDIA_WATERMARK_FONT", { infer: true });
        const esc = ctx.asset.watermark
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'")
          .replace(/:/g, "\\:")
          .replace(/%/g, "\\%");
        const parts = [
          `text='${esc}'`,
          "x=12",
          "y=H-th-12",
          "fontsize=24",
          "fontcolor=white@0.75",
          "box=1",
          "boxcolor=black@0.4",
        ];
        if (font) parts.push(`fontfile=${font}`);
        wmArgs.push("-vf", `drawtext=${parts.join(":")}`);
      }

      await this.runFfmpeg([
        "-i", src,
        ...wmArgs,
        "-c:v", "h264", "-c:a", "aac",
        "-hls_time", String(segSec),
        "-hls_playlist_type", "vod",
        "-hls_segment_filename", join(work, "seg%03d.ts"),
        "-f", "hls",
        join(work, "index.m3u8"),
      ]);

      // Poster from the first frame (best-effort).
      let posterKey: string | null = null;
      try {
        await this.runFfmpeg([
          "-i", src, "-ss", "0", "-frames:v", "1", join(work, "poster.jpg"),
        ]);
        const poster = await readFile(join(work, "poster.jpg"));
        posterKey = `${outPrefix}/poster.jpg`;
        await this.storage.putObject({
          bucket: this.bucket(),
          key: posterKey,
          body: poster,
          contentType: "image/jpeg",
        });
      } catch {
        /* poster optional */
      }

      for (const file of await readdir(work)) {
        if (!file.endsWith(".ts") && !file.endsWith(".m3u8")) continue;
        await this.storage.putObject({
          bucket: this.bucket(),
          key: `${outPrefix}/${file}`,
          body: await readFile(join(work, file)),
          contentType: file.endsWith(".m3u8")
            ? "application/vnd.apple.mpegurl"
            : "video/mp2t",
        });
      }

      await this.tenantDb.runPrivileged((tx) =>
        tx
          .update(schema.mediaAssets)
          .set({ status: "ready", playlistKey, posterKey, updatedAt: new Date() })
          .where(eq(schema.mediaAssets.id, assetId)),
      );
      this.logger.log(`transcoded media asset ${assetId} → ${playlistKey}`);
    } catch (err) {
      await this.tenantDb.runPrivileged((tx) =>
        tx
          .update(schema.mediaAssets)
          .set({
            status: "failed",
            error: (err as Error).message.slice(0, 500),
            updatedAt: new Date(),
          })
          .where(eq(schema.mediaAssets.id, assetId)),
      );
      throw err;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += String(d)));
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`)),
      );
    });
  }
}
