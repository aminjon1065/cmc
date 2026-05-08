import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "../../config/configuration";
import { S3_INTERNAL, S3_PUBLIC } from "./storage.tokens";

export type PresignedPut = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
};

export type PresignedGet = {
  url: string;
  method: "GET";
  expiresAt: string;
};

/**
 * Thin wrapper around the AWS S3 SDK for the bits the platform actually
 * uses: pre-sign PUT, pre-sign GET, HEAD, DELETE.
 *
 * Two clients live behind this service:
 *   - `internal` points at S3_ENDPOINT (private DNS); used for HEAD/DELETE
 *     issued from the API process.
 *   - `public`   points at S3_PUBLIC_ENDPOINT — the URL the *browser* will
 *     connect to. Pre-signed URLs are minted on this client so the
 *     embedded host matches the network the browser can reach.
 *
 * In dev both endpoints are the same (localhost:9000).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_INTERNAL) private readonly internal: S3Client,
    @Inject(S3_PUBLIC) private readonly publicClient: S3Client,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ---------- pre-signed URLs ----------

  async presignPut(input: {
    bucket: string;
    key: string;
    contentType: string;
    contentLengthRange?: { min?: number; max?: number };
    ttlSec: number;
  }): Promise<PresignedPut> {
    const cmd = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.contentType,
    });
    const url = await getSignedUrl(this.publicClient, cmd, {
      expiresIn: input.ttlSec,
    });
    return {
      url,
      method: "PUT",
      headers: { "Content-Type": input.contentType },
      expiresAt: new Date(Date.now() + input.ttlSec * 1000).toISOString(),
    };
  }

  async presignGet(input: {
    bucket: string;
    key: string;
    /** Filename to suggest to the browser via Content-Disposition. */
    downloadFilename?: string;
    contentType?: string;
    ttlSec: number;
  }): Promise<PresignedGet> {
    const cmd = new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ResponseContentType: input.contentType,
      ResponseContentDisposition: input.downloadFilename
        ? `attachment; filename="${sanitizeFilename(input.downloadFilename)}"`
        : undefined,
    });
    const url = await getSignedUrl(this.publicClient, cmd, {
      expiresIn: input.ttlSec,
    });
    return {
      url,
      method: "GET",
      expiresAt: new Date(Date.now() + input.ttlSec * 1000).toISOString(),
    };
  }

  // ---------- direct ops (server-side) ----------

  async head(input: { bucket: string; key: string }) {
    try {
      const res = await this.internal.send(
        new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
      );
      return {
        exists: true as const,
        contentLength: res.ContentLength,
        etag: res.ETag?.replaceAll('"', ""),
        contentType: res.ContentType,
        lastModified: res.LastModified,
      };
    } catch (err) {
      if (isNotFound(err)) {
        return { exists: false as const };
      }
      this.logger.warn(
        `HEAD ${input.bucket}/${input.key} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
  }

  async delete(input: { bucket: string; key: string }): Promise<void> {
    await this.internal.send(
      new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e.name === "NotFound" ||
    e.Code === "NoSuchKey" ||
    e.$metadata?.httpStatusCode === 404
  );
}

function sanitizeFilename(name: string): string {
  // Strip control chars and quotes — Content-Disposition can be tricked
  // by raw input. Keep ASCII-printable + common unicode word chars.
  return name.replace(/["\\\r\n]/g, "_").slice(0, 255);
}
