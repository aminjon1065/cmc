import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { INCIDENT_STATUSES, type IncidentStatus } from "@cmc/contracts";

/** Query params for GET /incidents. Numbers arrive as strings → @Type coerces. */
export class ListIncidentsQuery {
  @IsOptional()
  @IsIn(INCIDENT_STATUSES as unknown as string[])
  status?: IncidentStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  severity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  /** When true, only non-terminal incidents (reported/triaged/in_progress). */
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
