import { IsObject, IsOptional } from "class-validator";

export class UpdateGisFeatureDto {
  @IsOptional()
  @IsObject()
  geometry?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}
