import { IsString, Length } from "class-validator";

/** A TOTP code (6 digits) or a backup code (xxxxx-xxxxx). */
export class MfaCodeDto {
  @IsString()
  @Length(6, 14, { message: "code must be 6–14 characters" })
  code!: string;
}
