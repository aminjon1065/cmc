import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

const KINDS = ["point", "line", "polygon", "mixed"] as const;

export class CreateGisLayerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsIn(KINDS as unknown as string[])
  kind?: (typeof KINDS)[number];

  @IsOptional()
  @IsObject()
  style?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  schema?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  sourceUri?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
