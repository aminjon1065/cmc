import { IsOptional, IsUUID, ValidateIf } from "class-validator";

export class AssignIncidentDto {
  /** Target user id, or null to unassign. */
  @ValidateIf((o) => o.userId !== null)
  @IsOptional()
  @IsUUID()
  userId!: string | null;
}
