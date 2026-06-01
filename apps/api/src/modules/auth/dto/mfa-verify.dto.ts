import { IsString, Length } from "class-validator";

export class MfaVerifyDto {
  @IsString()
  @Length(10, 1024, { message: "mfaToken is required" })
  mfaToken!: string;

  @IsString()
  @Length(6, 14, { message: "code must be 6–14 characters" })
  code!: string;
}
