import { IsInt, Min, ValidateIf } from "class-validator";

export class SetFolderRetentionDto {
  /** Days after last update before soft-delete; null clears the policy. */
  @ValidateIf((o: SetFolderRetentionDto) => o.retentionDays !== null)
  @IsInt()
  @Min(1)
  retentionDays!: number | null;
}
