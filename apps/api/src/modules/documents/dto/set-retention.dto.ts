import { IsInt, Min, ValidateIf } from "class-validator";

export class SetRetentionDto {
  /** Days after last update before soft-delete; null inherits the folder policy. */
  @ValidateIf((o: SetRetentionDto) => o.retentionDays !== null)
  @IsInt()
  @Min(1)
  retentionDays!: number | null;
}
