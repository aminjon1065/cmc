import { IsBoolean } from "class-validator";

export class UpdateNotificationPrefDto {
  @IsBoolean()
  inApp!: boolean;

  @IsBoolean()
  email!: boolean;
}
