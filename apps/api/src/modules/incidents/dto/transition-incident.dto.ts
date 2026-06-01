import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { INCIDENT_STATUSES, type IncidentStatus } from "@cmc/contracts";

export class TransitionIncidentDto {
  @IsIn(INCIDENT_STATUSES as unknown as string[])
  to!: IncidentStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
