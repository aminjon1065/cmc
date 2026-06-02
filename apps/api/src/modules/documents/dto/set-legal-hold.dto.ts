import { IsBoolean } from "class-validator";

export class SetLegalHoldDto {
  @IsBoolean()
  hold!: boolean;
}
