import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import {
  GeoJsonGeometrySchema,
  type CreateGisLayerRequest,
  type GisFeatureResponse,
  type GisFeaturesListResponse,
  type GisLayerResponse,
  type GisLayersListResponse,
  type ListGisFeaturesQuery,
  type UpdateGisLayerRequest,
} from "@cmc/contracts";

/** Feature inputs accept geometry as `unknown`; the service validates GeoJSON. */
type FeatureCreateInput = {
  geometry: unknown;
  properties?: Record<string, unknown>;
};
type FeatureUpdateInput = {
  geometry?: unknown;
  properties?: Record<string, unknown>;
};
import { TenantDatabaseService } from "../database/tenant-database.service";
import { AuditService } from "../audit/audit.service";

type Actor = {
  userId: string;
  tenantId: string;
  ip?: string | null;
  userAgent?: string | null;
};

/** Raw row shape for a feature read (geometry comes back as a GeoJSON string). */
type FeatureRow = {
  id: string;
  layer_id: string;
  geometry: string;
  properties: Record<string, unknown> | null;
  created_at: string | Date;
  updated_at: string | Date;
};

/**
 * GIS domain logic (P2.7 / ADR-0037). Layers are plain rows (Drizzle); features
 * carry a PostGIS geometry read/written via `ST_AsGeoJSON` / `ST_GeomFromGeoJSON`
 * in raw SQL. Every read/write runs in the request's tenant transaction, so RLS
 * confines it to the caller's tenant (a cross-tenant id is a clean miss → 404).
 */
@Injectable()
export class GisService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly audit: AuditService,
  ) {}

  // ---------- layers ----------

  async createLayer(
    input: CreateGisLayerRequest,
    actor: Actor,
  ): Promise<GisLayerResponse> {
    const id = await this.tenantDb.run(async (tx) => {
      const [row] = await tx
        .insert(schema.gisLayers)
        .values({
          tenantId: actor.tenantId,
          name: input.name,
          kind: input.kind ?? "mixed",
          style: input.style ?? {},
          schema: input.schema ?? {},
          sourceUri: input.sourceUri ?? null,
          isPublic: input.isPublic ?? false,
          createdBy: actor.userId,
        })
        .returning({ id: schema.gisLayers.id });
      return row!.id;
    });
    await this.record(actor, "gis.layer.created", "gis_layer", id, {
      name: input.name,
      kind: input.kind ?? "mixed",
    });
    return (await this.getLayer(id))!;
  }

  async listLayers(): Promise<GisLayersListResponse> {
    return this.tenantDb.run(async (tx) => {
      const layers = await tx
        .select(this.layerSelect())
        .from(schema.gisLayers)
        .where(isNull(schema.gisLayers.deletedAt))
        .orderBy(desc(schema.gisLayers.createdAt));
      const counts = await this.featureCounts(
        tx,
        layers.map((l) => l.id),
      );
      return { layers: layers.map((l) => this.toLayer(l, counts.get(l.id) ?? 0)) };
    });
  }

  async getLayer(id: string): Promise<GisLayerResponse | null> {
    return this.tenantDb.run(async (tx) => {
      const row = (
        await tx
          .select(this.layerSelect())
          .from(schema.gisLayers)
          .where(
            and(eq(schema.gisLayers.id, id), isNull(schema.gisLayers.deletedAt)),
          )
          .limit(1)
      )[0];
      if (!row) return null;
      const counts = await this.featureCounts(tx, [row.id]);
      return this.toLayer(row, counts.get(row.id) ?? 0);
    });
  }

  async updateLayer(
    id: string,
    changes: UpdateGisLayerRequest,
    actor: Actor,
  ): Promise<GisLayerResponse> {
    if (!(await this.getLayer(id)))
      throw new NotFoundException("Layer not found");
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.gisLayers)
        .set({
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.kind !== undefined ? { kind: changes.kind } : {}),
          ...(changes.style !== undefined ? { style: changes.style } : {}),
          ...(changes.schema !== undefined ? { schema: changes.schema } : {}),
          ...(changes.sourceUri !== undefined
            ? { sourceUri: changes.sourceUri }
            : {}),
          ...(changes.isPublic !== undefined
            ? { isPublic: changes.isPublic }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.gisLayers.id, id)),
    );
    await this.record(actor, "gis.layer.updated", "gis_layer", id, {
      fields: Object.keys(changes),
    });
    return (await this.getLayer(id))!;
  }

  async deleteLayer(id: string, actor: Actor): Promise<void> {
    if (!(await this.getLayer(id)))
      throw new NotFoundException("Layer not found");
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.gisLayers)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.gisLayers.id, id)),
    );
    await this.record(actor, "gis.layer.deleted", "gis_layer", id);
  }

  // ---------- features ----------

  async createFeature(
    layerId: string,
    input: FeatureCreateInput,
    actor: Actor,
  ): Promise<GisFeatureResponse> {
    if (!(await this.getLayer(layerId)))
      throw new NotFoundException("Layer not found");
    const geojson = this.geoJson(input.geometry);
    const props = JSON.stringify(input.properties ?? {});

    const id = await this.tenantDb.run(async (tx) => {
      const rows = await tx.execute(sql`
        INSERT INTO gis_features (tenant_id, layer_id, geometry, properties, created_by)
        VALUES (
          ${actor.tenantId},
          ${layerId},
          ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326),
          ${props}::jsonb,
          ${actor.userId}
        )
        RETURNING id
      `);
      return (rows as unknown as Array<{ id: string }>)[0]!.id;
    });
    await this.record(actor, "gis.feature.created", "gis_feature", id, {
      layerId,
    });
    return (await this.getFeature(id))!;
  }

  async listFeatures(
    layerId: string,
    query: ListGisFeaturesQuery,
  ): Promise<GisFeaturesListResponse> {
    if (!(await this.getLayer(layerId)))
      throw new NotFoundException("Layer not found");
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);
    const bbox = this.parseBbox(query.bbox);

    return this.tenantDb.run(async (tx) => {
      const conds = [sql`deleted_at IS NULL`, sql`layer_id = ${layerId}`];
      if (bbox) {
        conds.push(
          sql`geometry && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)`,
        );
      }
      const where = sql.join(conds, sql` AND `);

      const rows = await tx.execute(sql`
        SELECT id, layer_id, ST_AsGeoJSON(geometry) AS geometry, properties,
               created_at, updated_at
          FROM gis_features
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT ${limit} OFFSET ${offset}
      `);
      const totals = await tx.execute(
        sql`SELECT count(*)::int AS c FROM gis_features WHERE ${where}`,
      );
      const total = Number((totals as unknown as Array<{ c: number }>)[0]?.c ?? 0);
      const features = (rows as unknown as FeatureRow[]).map((r) =>
        this.toFeature(r),
      );
      return { features, total, limit, offset };
    });
  }

  async getFeature(id: string): Promise<GisFeatureResponse | null> {
    return this.tenantDb.run(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, layer_id, ST_AsGeoJSON(geometry) AS geometry, properties,
               created_at, updated_at
          FROM gis_features
         WHERE id = ${id} AND deleted_at IS NULL
         LIMIT 1
      `);
      const r = (rows as unknown as FeatureRow[])[0];
      return r ? this.toFeature(r) : null;
    });
  }

  async updateFeature(
    id: string,
    changes: FeatureUpdateInput,
    actor: Actor,
  ): Promise<GisFeatureResponse> {
    if (!(await this.getFeature(id)))
      throw new NotFoundException("Feature not found");

    const sets = [sql`updated_at = now()`];
    if (changes.geometry !== undefined) {
      const geojson = this.geoJson(changes.geometry);
      sets.push(
        sql`geometry = ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)`,
      );
    }
    if (changes.properties !== undefined) {
      sets.push(sql`properties = ${JSON.stringify(changes.properties)}::jsonb`);
    }

    await this.tenantDb.run((tx) =>
      tx.execute(
        sql`UPDATE gis_features SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`,
      ),
    );
    await this.record(actor, "gis.feature.updated", "gis_feature", id, {
      fields: Object.keys(changes),
    });
    return (await this.getFeature(id))!;
  }

  async deleteFeature(id: string, actor: Actor): Promise<void> {
    if (!(await this.getFeature(id)))
      throw new NotFoundException("Feature not found");
    await this.tenantDb.run((tx) =>
      tx.execute(
        sql`UPDATE gis_features SET deleted_at = now(), updated_at = now() WHERE id = ${id}`,
      ),
    );
    await this.record(actor, "gis.feature.deleted", "gis_feature", id);
  }

  // ---------- vector tiles (P2.8) ----------

  /**
   * Render a Mapbox Vector Tile (`ST_AsMVT`) for a layer at z/x/y (P2.8 /
   * ADR-0038). Filters the layer's features by the tile envelope using the GIST
   * index (the bbox `&&` runs in WGS84 against the original geometry), then
   * transforms matches to Web Mercator for `ST_AsMVTGeom`. Returns the MVT bytes,
   * or null for an empty tile. RLS confines it to the caller's tenant.
   */
  async tile(
    layerId: string,
    z: number,
    x: number,
    y: number,
  ): Promise<Buffer | null> {
    return this.tenantDb.run(async (tx) => {
      const rows = await tx.execute(sql`
        WITH bounds AS (SELECT ST_TileEnvelope(${z}, ${x}, ${y}) AS merc)
        SELECT ST_AsMVT(t, 'features', 4096, 'geom') AS mvt
          FROM (
            SELECT f.id::text AS id,
                   f.properties,
                   ST_AsMVTGeom(ST_Transform(f.geometry, 3857), b.merc, 4096, 64, true) AS geom
              FROM gis_features f, bounds b
             WHERE f.layer_id = ${layerId}
               AND f.deleted_at IS NULL
               AND f.geometry && ST_Transform(b.merc, 4326)
          ) AS t
      `);
      const mvt = (rows as unknown as Array<{ mvt: Buffer | Uint8Array | null }>)[0]
        ?.mvt;
      if (!mvt) return null;
      const buf = Buffer.isBuffer(mvt) ? mvt : Buffer.from(mvt);
      return buf.length > 0 ? buf : null;
    });
  }

  // ---------- helpers ----------

  /** Validate the GeoJSON shape (clean 400) before it reaches PostGIS. */
  private geoJson(geometry: unknown): string {
    const parsed = GeoJsonGeometrySchema.safeParse(geometry);
    if (!parsed.success) {
      throw new BadRequestException("Invalid GeoJSON geometry");
    }
    return JSON.stringify(parsed.data);
  }

  /** Parse `minLng,minLat,maxLng,maxLat` → tuple, or null when absent. */
  private parseBbox(
    bbox: string | undefined,
  ): [number, number, number, number] | null {
    if (!bbox) return null;
    const parts = bbox.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new BadRequestException(
        "bbox must be 'minLng,minLat,maxLng,maxLat'",
      );
    }
    const [minLng, minLat, maxLng, maxLat] = parts as [
      number,
      number,
      number,
      number,
    ];
    if (minLng > maxLng || minLat > maxLat) {
      throw new BadRequestException("bbox min must not exceed max");
    }
    return [minLng, minLat, maxLng, maxLat];
  }

  private layerSelect() {
    return {
      id: schema.gisLayers.id,
      name: schema.gisLayers.name,
      kind: schema.gisLayers.kind,
      style: schema.gisLayers.style,
      schema: schema.gisLayers.schema,
      sourceUri: schema.gisLayers.sourceUri,
      isPublic: schema.gisLayers.isPublic,
      createdAt: schema.gisLayers.createdAt,
      updatedAt: schema.gisLayers.updatedAt,
    };
  }

  /** Non-deleted feature counts per layer (one grouped query, RLS-scoped). */
  private async featureCounts(
    tx: Parameters<Parameters<TenantDatabaseService["run"]>[0]>[0],
    layerIds: string[],
  ): Promise<Map<string, number>> {
    if (layerIds.length === 0) return new Map();
    const rows = await tx
      .select({
        layerId: schema.gisFeatures.layerId,
        c: sql<number>`count(*)::int`,
      })
      .from(schema.gisFeatures)
      .where(
        and(
          isNull(schema.gisFeatures.deletedAt),
          inArray(schema.gisFeatures.layerId, layerIds),
        ),
      )
      .groupBy(schema.gisFeatures.layerId);
    return new Map(rows.map((r) => [r.layerId, Number(r.c)]));
  }

  private toLayer(
    row: {
      id: string;
      name: string;
      kind: string;
      style: unknown;
      schema: unknown;
      sourceUri: string | null;
      isPublic: boolean;
      createdAt: Date;
      updatedAt: Date;
    },
    featureCount: number,
  ): GisLayerResponse {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as GisLayerResponse["kind"],
      style: (row.style ?? {}) as Record<string, unknown>,
      schema: (row.schema ?? {}) as Record<string, unknown>,
      sourceUri: row.sourceUri,
      isPublic: row.isPublic,
      featureCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toFeature(r: FeatureRow): GisFeatureResponse {
    return {
      id: r.id,
      layerId: r.layer_id,
      geometry: JSON.parse(r.geometry),
      properties: (r.properties ?? {}) as Record<string, unknown>,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  private async record(
    actor: Actor,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action,
      resourceType,
      resourceId,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      ...(metadata ? { metadata } : {}),
    });
  }
}
