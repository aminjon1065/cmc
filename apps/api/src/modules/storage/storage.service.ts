import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  UploadPartCommand,
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
    /** Exact size, in bytes. Embedded in the signature so the client cannot
     *  upload more bytes than declared at upload-init. Without this S3 will
     *  accept any size, and finalize() only catches it after the bytes are
     *  already on disk. */
    contentLength?: number;
    ttlSec: number;
  }): Promise<PresignedPut> {
    const cmd = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    });
    const url = await getSignedUrl(this.publicClient, cmd, {
      expiresIn: input.ttlSec,
    });
    // Content-Length is bound into the signature server-side; we do NOT
    // return it as a client-set header. Browsers forbid setting
    // Content-Length via XHR/fetch (they set it automatically from the
    // body), and S3 will validate the auto-set value against the signed
    // length on receipt.
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

  // ---------- multipart upload (P2.12 / ADR-0042) ----------

  /** Start an S3 multipart upload; returns the uploadId. */
  async createMultipartUpload(input: {
    bucket: string;
    key: string;
    contentType: string;
  }): Promise<string> {
    const res = await this.internal.send(
      new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        ContentType: input.contentType,
      }),
    );
    if (!res.UploadId) throw new Error("S3 did not return an UploadId");
    return res.UploadId;
  }

  /** Pre-sign a single UploadPart PUT (minted on the public client). */
  async presignUploadPart(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    ttlSec: number;
  }): Promise<string> {
    const cmd = new UploadPartCommand({
      Bucket: input.bucket,
      Key: input.key,
      UploadId: input.uploadId,
      PartNumber: input.partNumber,
    });
    return getSignedUrl(this.publicClient, cmd, { expiresIn: input.ttlSec });
  }

  /** Assemble the uploaded parts into the final object. */
  async completeMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    const Parts = [...input.parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));
    await this.internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        MultipartUpload: { Parts },
      }),
    );
  }

  /** Discard an in-flight multipart upload (frees the staged parts). */
  async abortMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
  }): Promise<void> {
    await this.internal.send(
      new AbortMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }),
    );
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

  /** Read an object's bytes (server-side) — used by the preview worker (P2.13). */
  async getObjectBytes(input: {
    bucket: string;
    key: string;
  }): Promise<Buffer> {
    const out = await this.internal.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
    if (!out.Body) throw new Error("GetObject returned no body");
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  /** Write an object's bytes (server-side) — used by the preview worker (P2.13). */
  async putObject(input: {
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<void> {
    await this.internal.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  }

  /**
   * Write an object under S3/MinIO Object Lock (WORM) — used for the audit
   * Merkle anchors (P1.11b / ADR-0029). The bucket MUST already exist with
   * object-lock enabled (provisioned out-of-band; we never CreateBucket here —
   * `HeadBucket`/`CreateBucket` trigger an aws-sdk lazy `import()` that breaks
   * under jest's VM-modules). Returns the object's version id (lock buckets are
   * versioned). GOVERNANCE retention can be overridden by a privileged user;
   * COMPLIANCE cannot, even by root, until `retainUntil`.
   */
  async putImmutableObject(input: {
    bucket: string;
    key: string;
    body: string;
    contentType?: string;
    lockMode: "GOVERNANCE" | "COMPLIANCE";
    retainUntil: Date;
  }): Promise<{ versionId: string | null }> {
    const res = await this.internal.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType ?? "application/json",
        ObjectLockMode: input.lockMode,
        ObjectLockRetainUntilDate: input.retainUntil,
      }),
    );
    return { versionId: res.VersionId ?? null };
  }

  /**
   * Connectivity probe for the health readiness check (P0.8 / ADR-0015).
   *
   * HEADs a sentinel key in the files bucket. The key need not exist — a
   * "not found" response still proves MinIO is reachable AND our
   * credentials are accepted (a 403 would throw, a connection failure
   * would throw). Returns normally when reachable, throws otherwise.
   *
   * Why HeadObject and not HeadBucket: `HeadObjectCommand` is the command
   * the documents module already exercises under jest, so it is proven
   * jest-safe; `HeadBucketCommand` triggers an aws-sdk lazy `import()`
   * that jest's VM-modules runtime cannot resolve
   * (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG). HeadObject is also
   * S3-generic, so this probe works unchanged against AWS S3, not just
   * MinIO. Exposed here (not via the raw S3 token) so HealthService
   * depends on the StorageModule's public surface.
   */
  async probeReachable(bucket: string): Promise<void> {
    // `head()` swallows not-found and only throws on real errors
    // (connection / auth / unexpected), which is exactly the
    // reachable-vs-unreachable signal a readiness probe needs.
    await this.head({ bucket, key: ".cmc-health-probe" });
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
