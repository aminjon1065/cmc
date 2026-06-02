import { IsBoolean } from "class-validator";

export class SetRestrictedDto {
  @IsBoolean()
  restricted!: boolean;
}
