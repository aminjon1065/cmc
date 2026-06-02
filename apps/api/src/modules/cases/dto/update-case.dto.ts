import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";

export class UpdateCaseDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  type?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  /** Nullable: pass null to clear the SLA target. */
  @IsOptional()
  @ValidateIf((o: UpdateCaseDto) => o.dueAt !== null)
  @IsISO8601()
  dueAt?: string | null;
}
