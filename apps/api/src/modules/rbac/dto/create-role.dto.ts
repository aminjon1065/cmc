import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateRoleDto {
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message:
      "slug must be lowercase letters/digits/underscore, starting with a letter",
  })
  slug!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissions!: string[];
}
