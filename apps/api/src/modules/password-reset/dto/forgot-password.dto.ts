import { IsEmail, MaxLength } from "class-validator";

export class ForgotPasswordDto {
  @IsEmail({}, { message: "email must be a valid address" })
  @MaxLength(320)
  email!: string;
}
