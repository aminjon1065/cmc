import {
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class CreateIncidentDto {
  @IsInt()
  @Min(1)
  @Max(5)
  severity!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  type!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  region!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  source?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  summary!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsISO8601()
  occurredAt!: string;
}
