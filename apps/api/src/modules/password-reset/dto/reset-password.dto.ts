import { IsString, MinLength, MaxLength } from "class-validator";

export class ResetPasswordDto {
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  token!: string;

  @IsString()
  @MinLength(8, { message: "newPassword must be at least 8 characters" })
  @MaxLength(256)
  newPassword!: string;
}
