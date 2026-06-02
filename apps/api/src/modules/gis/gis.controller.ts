import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type {
  GisFeatureResponse,
  GisFeaturesListResponse,
  GisLayerResponse,
  GisLayersListResponse,
} from "@cmc/contracts";
import { GisService } from "./gis.service";
import { CreateGisLayerDto } from "./dto/create-gis-layer.dto";
import { UpdateGisLayerDto } from "./dto/update-gis-layer.dto";
import { CreateGisFeatureDto } from "./dto/create-gis-feature.dto";
import { UpdateGisFeatureDto } from "./dto/update-gis-feature.dto";
import { ListGisFeaturesQueryDto } from "./dto/list-gis-features.query";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { TenantContext } from "../../common/tenant-context/tenant-context.service";

/**
 * GIS endpoints (P2.7 / ADR-0037). Layers are gated on `gis_layer:read`/`:edit`,
 * features on `gis_feature:write` for mutations + `gis_layer:read` for reads. RLS
 * confines everything to the caller's tenant (cross-tenant id → 404).
 */
@Controller("gis")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class GisController {
  constructor(private readonly gis: GisService) {}

  private actor(user: TenantContext, ip: string, req: Request) {
    return {
      userId: user.userId,
      tenantId: user.tenantId,
      ip: ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    };
  }

  // ---------- layers ----------

  @Post("layers")
  @Authorize("gis_layer:edit")
  @HttpCode(HttpStatus.CREATED)
  createLayer(
    @Body() body: CreateGisLayerDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<GisLayerResponse> {
    return this.gis.createLayer(body, this.actor(user, ip, req));
  }

  @Get("layers")
  @Authorize("gis_layer:read")
  listLayers(): Promise<GisLayersListResponse> {
    return this.gis.listLayers();
  }

  @Get("layers/:id")
  @Authorize("gis_layer:read")
  async getLayer(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<GisLayerResponse> {
    const layer = await this.gis.getLayer(id);
    if (!layer) throw new NotFoundException("Layer not found");
    return layer;
  }

  @Patch("layers/:id")
  @Authorize("gis_layer:edit")
  updateLayer(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateGisLayerDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<GisLayerResponse> {
    return this.gis.updateLayer(id, body, this.actor(user, ip, req));
  }

  @Delete("layers/:id")
  @Authorize("gis_layer:edit")
  @HttpCode(HttpStatus.NO_CONTENT)
  removeLayer(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.gis.deleteLayer(id, this.actor(user, ip, req));
  }

  // ---------- features ----------

  @Post("layers/:layerId/features")
  @Authorize("gis_feature:write")
  @HttpCode(HttpStatus.CREATED)
  createFeature(
    @Param("layerId", ParseUUIDPipe) layerId: string,
    @Body() body: CreateGisFeatureDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<GisFeatureResponse> {
    return this.gis.createFeature(layerId, body, this.actor(user, ip, req));
  }

  @Get("layers/:layerId/features")
  @Authorize("gis_layer:read")
  listFeatures(
    @Param("layerId", ParseUUIDPipe) layerId: string,
    @Query() query: ListGisFeaturesQueryDto,
  ): Promise<GisFeaturesListResponse> {
    return this.gis.listFeatures(layerId, query);
  }

  @Get("features/:id")
  @Authorize("gis_layer:read")
  async getFeature(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<GisFeatureResponse> {
    const feature = await this.gis.getFeature(id);
    if (!feature) throw new NotFoundException("Feature not found");
    return feature;
  }

  @Patch("features/:id")
  @Authorize("gis_feature:write")
  updateFeature(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: UpdateGisFeatureDto,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<GisFeatureResponse> {
    return this.gis.updateFeature(id, body, this.actor(user, ip, req));
  }

  @Delete("features/:id")
  @Authorize("gis_feature:write")
  @HttpCode(HttpStatus.NO_CONTENT)
  removeFeature(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantContext,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.gis.deleteFeature(id, this.actor(user, ip, req));
  }

  // ---------- vector tiles (P2.8 / ADR-0038) ----------

  /**
   * MVT vector tile for a layer at z/x/y. Binary response (`@Res`); empty tiles
   * are `204`. `gis_layer:read` (MapLibre sends the bearer via transformRequest).
   */
  @Get("tiles/:layerId/:z/:x/:y.mvt")
  @Authorize("gis_layer:read")
  async tile(
    @Param("layerId", ParseUUIDPipe) layerId: string,
    @Param("z", ParseIntPipe) z: number,
    @Param("x", ParseIntPipe) x: number,
    @Param("y", ParseIntPipe) y: number,
    @Res() res: Response,
  ): Promise<void> {
    const max = z >= 0 && z <= 24 ? 2 ** z : 0;
    if (z < 0 || z > 24 || x < 0 || y < 0 || x >= max || y >= max) {
      res.status(HttpStatus.BAD_REQUEST).json({ message: "invalid tile coordinates" });
      return;
    }
    const mvt = await this.gis.tile(layerId, z, x, y);
    res.setHeader("Content-Type", "application/vnd.mapbox-vector-tile");
    res.setHeader("Cache-Control", "private, max-age=60");
    if (!mvt) {
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }
    res.status(HttpStatus.OK).send(mvt);
  }
}
