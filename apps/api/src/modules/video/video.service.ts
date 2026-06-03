import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@cmc/db";
import type {
  CreateVideoRoomRequest,
  VideoJoinResponse,
  VideoLinkType,
  VideoRecording,
  VideoRoom,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { StorageService } from "../storage/storage.service";
import type { AppConfig } from "../../config/configuration";

type Actor = { userId: string; tenantId: string; email: string };
type RoomRow = typeof schema.videoRooms.$inferSelect;
type RecordingRow = typeof schema.videoRecordings.$inferSelect;

/**
 * Video-conference rooms (P4.2 / ADR-0061). Owns room metadata + mints the
 * short-lived, room-scoped LiveKit join token (the only credential the browser
 * gets — never the platform JWT). The `livekit-server-sdk` is dynamic-imported
 * (gated lazy seam): token minting is pure JWT signing with the API key/secret
 * so it works without a running LiveKit (keeps this e2e-testable); the room
 * admin client (close → SFU deleteRoom) is best-effort and only used when
 * `LIVEKIT_ENABLED`. The SFU room itself is auto-created by LiveKit on first join.
 */
@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private toRoom(r: RoomRow): VideoRoom {
    return {
      id: r.id,
      name: r.name,
      livekitRoom: r.livekitRoom,
      status: r.status === "closed" ? "closed" : "open",
      linkedType:
        r.linkedType === "incident" || r.linkedType === "case"
          ? r.linkedType
          : null,
      linkedId: r.linkedId,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      closedAt: r.closedAt ? r.closedAt.toISOString() : null,
    };
  }

  async createRoom(
    actor: Actor,
    input: CreateVideoRoomRequest,
  ): Promise<VideoRoom> {
    if ((input.linkedType && !input.linkedId) || (!input.linkedType && input.linkedId)) {
      throw new BadRequestException(
        "linkedType and linkedId must be provided together.",
      );
    }
    const livekitRoom = `room-${randomUUID()}`;
    const [row] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.videoRooms)
        .values({
          tenantId: actor.tenantId,
          name: input.name,
          livekitRoom,
          createdBy: actor.userId,
          linkedType: input.linkedType ?? null,
          linkedId: input.linkedId ?? null,
        })
        .returning(),
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "video.room.created",
      resourceType: "video_room",
      resourceId: row!.id,
      outcome: "success",
      metadata: input.linkedType
        ? { linkedType: input.linkedType, linkedId: input.linkedId }
        : null,
    });
    return this.toRoom(row!);
  }

  async listRooms(filter?: {
    linkedType: VideoLinkType;
    linkedId: string;
  }): Promise<VideoRoom[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.videoRooms)
        .where(
          filter
            ? and(
                eq(schema.videoRooms.linkedType, filter.linkedType),
                eq(schema.videoRooms.linkedId, filter.linkedId),
              )
            : undefined,
        )
        .orderBy(desc(schema.videoRooms.createdAt)),
    );
    return rows.map((r) => this.toRoom(r));
  }

  private async getRoomRowOrFail(id: string): Promise<RoomRow> {
    const [row] = await this.tenantDb.run((tx) =>
      tx.select().from(schema.videoRooms).where(eq(schema.videoRooms.id, id)).limit(1),
    );
    if (!row) throw new NotFoundException("Video room not found");
    return row;
  }

  async getRoom(id: string): Promise<VideoRoom> {
    return this.toRoom(await this.getRoomRowOrFail(id));
  }

  /** Mint a room-scoped LiveKit join token for the caller. */
  async mintToken(actor: Actor, id: string): Promise<VideoJoinResponse> {
    const room = await this.getRoomRowOrFail(id);
    if (room.status === "closed") {
      throw new ConflictException("This room is closed.");
    }
    const { AccessToken } = await import("livekit-server-sdk");
    const at = new AccessToken(
      this.config.get("LIVEKIT_API_KEY", { infer: true }),
      this.config.get("LIVEKIT_API_SECRET", { infer: true }),
      {
        identity: actor.userId,
        name: actor.email.split("@")[0] || actor.email,
        ttl: this.config.get("LIVEKIT_TOKEN_TTL_SECONDS", { infer: true }),
      },
    );
    at.addGrant({
      roomJoin: true,
      room: room.livekitRoom,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "video.room.joined",
      resourceType: "video_room",
      resourceId: room.id,
      outcome: "success",
    });
    return {
      token,
      url: this.config.get("LIVEKIT_URL", { infer: true }),
      roomName: room.livekitRoom,
      identity: actor.userId,
      enabled: this.config.get("LIVEKIT_ENABLED", { infer: true }),
    };
  }

  /** Close a room. The creator may close their own; otherwise needs `video:manage`. */
  async closeRoom(actor: Actor, id: string): Promise<VideoRoom> {
    const room = await this.getRoomRowOrFail(id);
    if (room.createdBy !== actor.userId) {
      const canManage = await this.rbac.hasPermission(
        actor.tenantId,
        actor.userId,
        "video:manage",
      );
      if (!canManage) {
        throw new ForbiddenException("video:manage required to close this room.");
      }
    }
    const [row] = await this.tenantDb.run((tx) =>
      tx
        .update(schema.videoRooms)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(schema.videoRooms.id, id))
        .returning(),
    );

    // Best-effort: drop the SFU room so active participants are disconnected.
    if (this.config.get("LIVEKIT_ENABLED", { infer: true })) {
      try {
        const { RoomServiceClient } = await import("livekit-server-sdk");
        const svc = new RoomServiceClient(
          this.config.get("LIVEKIT_API_URL", { infer: true }),
          this.config.get("LIVEKIT_API_KEY", { infer: true }),
          this.config.get("LIVEKIT_API_SECRET", { infer: true }),
        );
        await svc.deleteRoom(room.livekitRoom);
      } catch (err) {
        this.logger.warn(
          `LiveKit deleteRoom(${room.livekitRoom}) failed: ${(err as Error).message}`,
        );
      }
    }

    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "video.room.closed",
      resourceType: "video_room",
      resourceId: id,
      outcome: "success",
    });
    return this.toRoom(row!);
  }

  // ---------- recordings (P4.2c) ----------

  private toRecording(r: RecordingRow): VideoRecording {
    return {
      id: r.id,
      roomId: r.roomId,
      status:
        r.status === "complete"
          ? "complete"
          : r.status === "failed"
            ? "failed"
            : "active",
      startedBy: r.startedBy,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    };
  }

  async listRecordings(roomId: string): Promise<VideoRecording[]> {
    await this.getRoomRowOrFail(roomId); // 404 + tenant scope
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.videoRecordings)
        .where(eq(schema.videoRecordings.roomId, roomId))
        .orderBy(desc(schema.videoRecordings.startedAt)),
    );
    return rows.map((r) => this.toRecording(r));
  }

  /**
   * Start recording a room (manual). Requires a running egress service — gated
   * on `LIVEKIT_ENABLED` (503 when off). The egress composites the room and
   * uploads an MP4 to S3/MinIO at `recordings/<tenant>/<room>/<id>.mp4`.
   */
  async startRecording(actor: Actor, roomId: string): Promise<VideoRecording> {
    const room = await this.getRoomRowOrFail(roomId);
    if (room.status === "closed") {
      throw new ConflictException("Cannot record a closed room.");
    }
    if (!this.config.get("LIVEKIT_ENABLED", { infer: true })) {
      throw new ServiceUnavailableException(
        "Recording is unavailable (LiveKit egress not enabled).",
      );
    }

    const recordingId = randomUUID();
    const bucket = this.config.get("S3_BUCKET_FILES", { infer: true });
    const s3Key = `recordings/${actor.tenantId}/${roomId}/${recordingId}.mp4`;

    const { EgressClient, EncodedFileOutput, EncodedFileType, S3Upload } =
      await import("livekit-server-sdk");
    const client = new EgressClient(
      this.config.get("LIVEKIT_API_URL", { infer: true }),
      this.config.get("LIVEKIT_API_KEY", { infer: true }),
      this.config.get("LIVEKIT_API_SECRET", { infer: true }),
    );
    const fileOutput = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: s3Key,
      output: {
        case: "s3",
        value: new S3Upload({
          endpoint: this.config.get("LIVEKIT_EGRESS_S3_ENDPOINT", {
            infer: true,
          }),
          accessKey: this.config.get("S3_ACCESS_KEY", { infer: true }),
          secret: this.config.get("S3_SECRET_KEY", { infer: true }),
          bucket,
          region: this.config.get("S3_REGION", { infer: true }),
          forcePathStyle: true,
        }),
      },
    });
    const info = await client.startRoomCompositeEgress(room.livekitRoom, {
      file: fileOutput,
    });

    const [row] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.videoRecordings)
        .values({
          id: recordingId,
          tenantId: actor.tenantId,
          roomId,
          egressId: info.egressId,
          status: "active",
          s3Key,
          startedBy: actor.userId,
        })
        .returning(),
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "video.recording.started",
      resourceType: "video_recording",
      resourceId: row!.id,
      outcome: "success",
      metadata: { roomId, egressId: info.egressId },
    });
    return this.toRecording(row!);
  }

  private async getRecordingRowOrFail(id: string): Promise<RecordingRow> {
    const [row] = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.videoRecordings)
        .where(eq(schema.videoRecordings.id, id))
        .limit(1),
    );
    if (!row) throw new NotFoundException("Recording not found");
    return row;
  }

  async stopRecording(actor: Actor, id: string): Promise<VideoRecording> {
    const rec = await this.getRecordingRowOrFail(id);
    if (rec.status === "active" && rec.egressId) {
      if (this.config.get("LIVEKIT_ENABLED", { infer: true })) {
        try {
          const { EgressClient } = await import("livekit-server-sdk");
          const client = new EgressClient(
            this.config.get("LIVEKIT_API_URL", { infer: true }),
            this.config.get("LIVEKIT_API_KEY", { infer: true }),
            this.config.get("LIVEKIT_API_SECRET", { infer: true }),
          );
          await client.stopEgress(rec.egressId);
        } catch (err) {
          this.logger.warn(
            `LiveKit stopEgress(${rec.egressId}) failed: ${(err as Error).message}`,
          );
        }
      }
    }
    const [row] = await this.tenantDb.run((tx) =>
      tx
        .update(schema.videoRecordings)
        .set({ status: "complete", endedAt: new Date() })
        .where(eq(schema.videoRecordings.id, id))
        .returning(),
    );
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "video.recording.stopped",
      resourceType: "video_recording",
      resourceId: id,
      outcome: "success",
    });
    return this.toRecording(row!);
  }

  /** Presigned GET URL for a recording's MP4 (the row scopes it to the tenant). */
  async recordingDownloadUrl(id: string): Promise<string> {
    const rec = await this.getRecordingRowOrFail(id);
    const presigned = await this.storage.presignGet({
      bucket: this.config.get("S3_BUCKET_FILES", { infer: true }),
      key: rec.s3Key,
      downloadFilename: `recording-${rec.id}.mp4`,
      contentType: "video/mp4",
      ttlSec: 300,
    });
    return presigned.url;
  }
}
