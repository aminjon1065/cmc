import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/** Query params for GET /gis/layers/:layerId/features. */
export class ListGisFeaturesQueryDto {
  /** `minLng,minLat,maxLng,maxLat` (WGS84) envelope filter. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bbox?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
