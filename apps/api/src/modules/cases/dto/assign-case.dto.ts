import { IsUUID, ValidateIf } from "class-validator";

export class AssignCaseDto {
  /** The assignee user id, or null to unassign. */
  @ValidateIf((o: AssignCaseDto) => o.userId !== null)
  @IsUUID()
  userId!: string | null;
}
