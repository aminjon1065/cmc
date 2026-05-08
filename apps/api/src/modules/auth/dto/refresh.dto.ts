import { IsString, MinLength, MaxLength } from "class-validator";

export class RefreshDto {
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  refreshToken!: string;
}
