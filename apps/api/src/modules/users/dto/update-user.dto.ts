import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from "class-validator";

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Assign (uuid) or clear (null) the user's region (P4.6). */
  @IsOptional()
  @ValidateIf((o: UpdateUserDto) => o.regionId !== null)
  @IsUUID()
  regionId?: string | null;
}
