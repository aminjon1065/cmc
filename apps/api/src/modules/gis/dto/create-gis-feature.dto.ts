import { IsObject, IsOptional } from "class-validator";

/**
 * `geometry` is accepted as an object and validated as GeoJSON in the service
 * (then by PostGIS). class-validator doesn't recurse into a plain-object
 * property, so the GeoJSON passes through intact.
 */
export class CreateGisFeatureDto {
  @IsObject()
  geometry!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}
