import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { CASE_STATUSES, type CaseStatus } from "@cmc/contracts";

export class TransitionCaseDto {
  @IsIn(CASE_STATUSES as unknown as string[])
  to!: CaseStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
