import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { parse as parseCsv } from "csv-parse/sync";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import {
  CreateIncidentRequestSchema,
  type CreateImportRequest,
  type ImportJob,
  type ImportRowError,
  type ImportUploadInitRequest,
  type ImportUploadInitResponse,
  type Permission,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import type { TenantTx } from "../database/tenant-database.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import type { AppConfig } from "../../config/configuration";
import { IMPORT_QUEUE, type ImportQueue } from "./import.queue";

type Actor = { tenantId: string; userId: string };
type RowError = { rowNum: number; reason: string; raw: unknown };

const GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

function numOrNull(n: number | null | undefined): string | null {
  return n === null || n === undefined ? null : String(n);
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
/** Copy a Node Buffer into a standalone ArrayBuffer (adm-zip buffers share a pool). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

/**
 * Bulk data-import service (P3.11 / ADR-0056). `create` records a job + enqueues
 * it; the worker calls `runJob`, which downloads the source object, parses it
 * (CSV/XLSX → incident rows; GeoJSON/Shapefile → GIS features), validates each
 * row, commits the valid ones, and quarantines the rest (`import_row_errors`).
 * Per-row inserts run inside a SAVEPOINT so one bad row can't abort the whole
 * import (partial-commit + quarantine — the confirmed P3.11 model). The whole
 * pass is one transaction, so valid rows + quarantine + counts land atomically.
 * Heavy parsers (xlsx/shapefile/adm-zip) are dynamic-imported so they never load
 * unless that kind actually runs.
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);
  private readonly filesBucket: string;
  private readonly maxRows: number;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    config: ConfigService<AppConfig, true>,
    @Inject(IMPORT_QUEUE) private readonly queue: ImportQueue,
  ) {
    this.filesBucket = config.get("S3_BUCKET_FILES", { infer: true });
    this.maxRows = config.get("IMPORT_MAX_ROWS", { infer: true });
  }

  // ---------- source upload (P3.11b) ----------

  /**
   * Presign a PUT for an import source object under `imports/<tenant>/…`. No
   * document row is created — the bytes are a transient import source. Gated on
   * `import:run` at the controller; the actual import still re-checks the
   * target-domain perm at `create`.
   */
  async initUpload(
    input: ImportUploadInitRequest,
    actor: Actor,
  ): Promise<ImportUploadInitResponse> {
    const safe = input.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const sourceKey = `imports/${actor.tenantId}/${randomUUID()}-${safe}`;
    const upload = await this.storage.presignPut({
      bucket: this.filesBucket,
      key: sourceKey,
      contentType: input.contentType ?? "application/octet-stream",
      ttlSec: 900,
    });
    return {
      sourceKey,
      upload: {
        url: upload.url,
        method: "PUT",
        headers: upload.headers,
        expiresAt: upload.expiresAt,
      },
    };
  }

  // ---------- create + read ----------

  async create(input: CreateImportRequest, actor: Actor): Promise<ImportJob> {
    // Gate on the *target-domain* write permission (not just `import:run`) so a
    // bulk import can't be used to escalate past per-domain RBAC.
    const targetPerm: Permission = input.kind.endsWith("_incidents")
      ? "incident:create"
      : "gis_feature:write";
    const allowed = await this.rbac.hasPermission(
      actor.tenantId,
      actor.userId,
      targetPerm,
    );
    if (!allowed) {
      throw new ForbiddenException(
        `Importing ${input.kind} requires ${targetPerm}.`,
      );
    }

    const row = await this.tenantDb.run(async (tx) => {
      const [r] = await tx
        .insert(schema.importJobs)
        .values({
          tenantId: actor.tenantId,
          kind: input.kind,
          sourceKey: input.sourceKey,
          targetId: input.targetId ?? null,
          status: "queued",
          createdBy: actor.userId,
        })
        .returning();
      return r!;
    });

    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "import.created",
      resourceType: "import",
      resourceId: row.id,
      outcome: "success",
      metadata: { kind: input.kind },
    });

    await this.queue.enqueue({ tenantId: actor.tenantId, jobId: row.id });
    return this.toJob(row);
  }

  async list(): Promise<ImportJob[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.importJobs)
        .orderBy(desc(schema.importJobs.createdAt))
        .limit(200),
    );
    return rows.map((r) => this.toJob(r));
  }

  async get(id: string): Promise<ImportJob> {
    const row = await this.tenantDb.run(async (tx) => {
      const [r] = await tx
        .select()
        .from(schema.importJobs)
        .where(eq(schema.importJobs.id, id));
      return r ?? null;
    });
    if (!row) throw new NotFoundException("Import job not found.");
    return this.toJob(row);
  }

  async listErrors(jobId: string): Promise<ImportRowError[]> {
    const job = await this.tenantDb.run(async (tx) => {
      const [r] = await tx
        .select({ id: schema.importJobs.id })
        .from(schema.importJobs)
        .where(eq(schema.importJobs.id, jobId));
      return r ?? null;
    });
    if (!job) throw new NotFoundException("Import job not found.");
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.importRowErrors)
        .where(eq(schema.importRowErrors.jobId, jobId))
        .orderBy(schema.importRowErrors.rowNum)
        .limit(1000),
    );
    return rows.map((r) => ({
      rowNum: r.rowNum,
      reason: r.reason,
      raw: r.raw ?? null,
    }));
  }

  // ---------- worker entry ----------

  /**
   * Process a queued import. Called by the worker (and directly by tests). The
   * queued→processing flip is a compare-and-set: only one attempt wins, so a
   * BullMQ retry can't double-import. A genuinely-not-yet-visible row (the
   * enqueue-before-commit race) throws so the retry picks it up later.
   */
  async runJob(tenantId: string, jobId: string): Promise<void> {
    const claim = await this.tenantDb.runForTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.importJobs)
        .where(eq(schema.importJobs.id, jobId));
      if (!row) return { state: "missing" as const };
      const flipped = await tx
        .update(schema.importJobs)
        .set({ status: "processing", updatedAt: new Date() })
        .where(
          and(
            eq(schema.importJobs.id, jobId),
            eq(schema.importJobs.status, "queued"),
          ),
        )
        .returning({ id: schema.importJobs.id });
      return flipped.length
        ? { state: "claimed" as const, job: row }
        : { state: "taken" as const };
    });

    if (claim.state === "missing") {
      throw new Error(`import job ${jobId} not found (will retry)`);
    }
    if (claim.state === "taken") {
      this.logger.warn(`import job ${jobId} already claimed — skipping`);
      return;
    }

    const job = claim.job;
    let bytes: Buffer;
    try {
      bytes = await this.storage.getObjectBytes({
        bucket: this.filesBucket,
        key: job.sourceKey,
      });
    } catch (e) {
      await this.failJob(tenantId, jobId, `Source file unreadable: ${msg(e)}`);
      return;
    }

    try {
      switch (job.kind) {
        case "csv_incidents":
          await this.processIncidentRows(
            tenantId,
            job.id,
            job.createdBy,
            this.parseCsvRows(bytes),
          );
          break;
        case "xlsx_incidents":
          await this.processIncidentRows(
            tenantId,
            job.id,
            job.createdBy,
            await this.parseXlsxRows(bytes),
          );
          break;
        case "geojson_gis":
          await this.processGisFeatures(
            tenantId,
            job.id,
            job.createdBy,
            job.targetId,
            this.parseGeoJsonFeatures(bytes),
          );
          break;
        case "shapefile_gis":
          await this.processGisFeatures(
            tenantId,
            job.id,
            job.createdBy,
            job.targetId,
            await this.parseShapefileFeatures(bytes),
          );
          break;
        default:
          await this.failJob(tenantId, jobId, `Unknown import kind: ${job.kind}`);
      }
    } catch (e) {
      await this.failJob(tenantId, jobId, msg(e));
    }
  }

  // ---------- parsers (return raw rows/features; never touch the DB) ----------

  private parseCsvRows(bytes: Buffer): Record<string, string>[] {
    try {
      return parseCsv(bytes, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }) as Record<string, string>[];
    } catch (e) {
      throw new Error(`CSV parse failed: ${msg(e)}`);
    }
  }

  private async parseXlsxRows(bytes: Buffer): Promise<Record<string, string>[]> {
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(bytes, { type: "buffer" });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new Error("workbook has no sheets");
      const sheet = wb.Sheets[sheetName]!;
      // raw:false → cells as formatted strings (matches the CSV string path).
      return XLSX.utils.sheet_to_json(sheet, {
        defval: "",
        raw: false,
      }) as Record<string, string>[];
    } catch (e) {
      throw new Error(`XLSX parse failed: ${msg(e)}`);
    }
  }

  private parseGeoJsonFeatures(bytes: Buffer): unknown[] {
    try {
      const doc = JSON.parse(bytes.toString("utf8")) as {
        type?: string;
        features?: unknown[];
      };
      if (doc?.type !== "FeatureCollection" || !Array.isArray(doc.features)) {
        throw new Error("not a GeoJSON FeatureCollection");
      }
      return doc.features;
    } catch (e) {
      throw new Error(`GeoJSON parse failed: ${msg(e)}`);
    }
  }

  /**
   * Parse a zipped shapefile (.shp + .dbf) into GeoJSON features. Coordinates are
   * taken as-is — the source MUST be WGS84 (EPSG:4326); reprojection (proj4) is a
   * future enhancement.
   */
  private async parseShapefileFeatures(bytes: Buffer): Promise<unknown[]> {
    try {
      const AdmZip = (await import("adm-zip")).default;
      const shapefile = await import("shapefile");
      const zip = new AdmZip(bytes);
      const entries = zip.getEntries();
      const shp = entries.find((e) =>
        e.entryName.toLowerCase().endsWith(".shp"),
      );
      const dbf = entries.find((e) =>
        e.entryName.toLowerCase().endsWith(".dbf"),
      );
      if (!shp) throw new Error("zip contains no .shp");
      const fc = await shapefile.read(
        toArrayBuffer(shp.getData()),
        dbf ? toArrayBuffer(dbf.getData()) : undefined,
      );
      return Array.isArray(fc.features) ? fc.features : [];
    } catch (e) {
      throw new Error(`Shapefile parse failed: ${msg(e)}`);
    }
  }

  // ---------- processors (validate + partial-commit + quarantine) ----------

  private async processIncidentRows(
    tenantId: string,
    jobId: string,
    createdBy: string | null,
    records: Record<string, string>[],
  ): Promise<void> {
    const { rows, note } = this.cap(records);
    await this.tenantDb.runForTenant(tenantId, async (tx) => {
      let inserted = 0;
      const errors: RowError[] = [];
      for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 1; // 1-based data row (header excluded)
        const raw = rows[i]!;
        const candidate = {
          severity:
            raw.severity !== undefined && raw.severity !== ""
              ? Number(raw.severity)
              : undefined,
          type: raw.type,
          region: raw.region,
          source: raw.source || undefined,
          summary: raw.summary,
          description: raw.description || undefined,
          latitude: raw.latitude ? Number(raw.latitude) : undefined,
          longitude: raw.longitude ? Number(raw.longitude) : undefined,
          occurredAt: raw.occurredAt,
        };
        const parsed = CreateIncidentRequestSchema.safeParse(candidate);
        if (!parsed.success) {
          errors.push({ rowNum, reason: this.zodMsg(parsed.error), raw });
          continue;
        }
        const inc = parsed.data;
        try {
          await tx.transaction(async (sp) => {
            await sp.insert(schema.incidents).values({
              tenantId,
              severity: inc.severity,
              status: "reported",
              type: inc.type,
              region: inc.region,
              source: inc.source ?? null,
              summary: inc.summary,
              description: inc.description ?? null,
              latitude: numOrNull(inc.latitude),
              longitude: numOrNull(inc.longitude),
              occurredAt: new Date(inc.occurredAt),
              reportedBy: createdBy,
            });
          });
          inserted++;
        } catch (e) {
          errors.push({ rowNum, reason: msg(e), raw });
        }
      }
      await this.finalize(tx, {
        tenantId,
        jobId,
        createdBy,
        total: rows.length,
        inserted,
        errors,
        note,
      });
    });
  }

  private async processGisFeatures(
    tenantId: string,
    jobId: string,
    createdBy: string | null,
    layerId: string | null,
    features: unknown[],
  ): Promise<void> {
    if (!layerId) throw new Error("GIS import has no target layer");
    const { rows, note } = this.cap(features);
    await this.tenantDb.runForTenant(tenantId, async (tx) => {
      // Layer must exist (RLS scopes the check to this tenant). Whole-job fail if
      // it doesn't — that's an operator mistake, not a per-row issue.
      const layer = await tx
        .select({ id: schema.gisLayers.id })
        .from(schema.gisLayers)
        .where(eq(schema.gisLayers.id, layerId));
      if (!layer.length) throw new Error("Target GIS layer not found");

      let inserted = 0;
      const errors: RowError[] = [];
      for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 1;
        const feat = rows[i] as {
          geometry?: { type?: string };
          properties?: unknown;
        };
        const geom = feat?.geometry;
        if (
          !geom ||
          typeof geom.type !== "string" ||
          !GEOMETRY_TYPES.has(geom.type)
        ) {
          errors.push({
            rowNum,
            reason: "feature has no valid GeoJSON geometry",
            raw: feat,
          });
          continue;
        }
        const geojson = JSON.stringify(geom);
        const props = JSON.stringify(feat.properties ?? {});
        try {
          await tx.transaction(async (sp) => {
            await sp.execute(sql`
              INSERT INTO gis_features (tenant_id, layer_id, geometry, properties, created_by)
              VALUES (
                ${tenantId},
                ${layerId},
                ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326),
                ${props}::jsonb,
                ${createdBy}
              )
            `);
          });
          inserted++;
        } catch (e) {
          errors.push({ rowNum, reason: msg(e), raw: feat });
        }
      }
      await this.finalize(tx, {
        tenantId,
        jobId,
        createdBy,
        total: rows.length,
        inserted,
        errors,
        note,
      });
    });
  }

  // ---------- helpers ----------

  /** Cap the row set at IMPORT_MAX_ROWS, returning a note if truncated. */
  private cap<T>(all: T[]): { rows: T[]; note: string | null } {
    if (all.length <= this.maxRows) return { rows: all, note: null };
    return {
      rows: all.slice(0, this.maxRows),
      note: `truncated to ${this.maxRows} rows (source had ${all.length})`,
    };
  }

  private async finalize(
    tx: TenantTx,
    args: {
      tenantId: string;
      jobId: string;
      createdBy: string | null;
      total: number;
      inserted: number;
      errors: RowError[];
      note: string | null;
    },
  ): Promise<void> {
    if (args.errors.length) {
      await tx.insert(schema.importRowErrors).values(
        args.errors.map((e) => ({
          tenantId: args.tenantId,
          jobId: args.jobId,
          rowNum: e.rowNum,
          reason: e.reason.slice(0, 2000),
          raw: (e.raw ?? null) as unknown,
        })),
      );
    }
    await tx
      .update(schema.importJobs)
      .set({
        status: "completed",
        totalRows: args.total,
        insertedRows: args.inserted,
        failedRows: args.errors.length,
        error: args.note,
        updatedAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(schema.importJobs.id, args.jobId));
    await this.audit.record({
      tenantId: args.tenantId,
      actorId: args.createdBy,
      actorType: "user",
      action: "import.completed",
      resourceType: "import",
      resourceId: args.jobId,
      outcome: "success",
      metadata: {
        total: args.total,
        inserted: args.inserted,
        failed: args.errors.length,
      },
    });
  }

  private async failJob(
    tenantId: string,
    jobId: string,
    reason: string,
  ): Promise<void> {
    await this.tenantDb.runForTenant(tenantId, (tx) =>
      tx
        .update(schema.importJobs)
        .set({
          status: "failed",
          error: reason.slice(0, 2000),
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(schema.importJobs.id, jobId)),
    );
    await this.audit.record({
      tenantId,
      actorType: "user",
      action: "import.failed",
      resourceType: "import",
      resourceId: jobId,
      outcome: "failure",
      metadata: { reason: reason.slice(0, 500) },
    });
    this.logger.warn(`import job ${jobId} failed: ${reason}`);
  }

  private zodMsg(err: {
    issues: { path: (string | number)[]; message: string }[];
  }): string {
    return err.issues
      .map((i) => `${i.path.join(".") || "(row)"}: ${i.message}`)
      .join("; ");
  }

  private toJob(row: typeof schema.importJobs.$inferSelect): ImportJob {
    return {
      id: row.id,
      kind: row.kind as ImportJob["kind"],
      sourceKey: row.sourceKey,
      targetId: row.targetId,
      status: row.status as ImportJob["status"],
      totalRows: row.totalRows,
      insertedRows: row.insertedRows,
      failedRows: row.failedRows,
      error: row.error,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }
}
