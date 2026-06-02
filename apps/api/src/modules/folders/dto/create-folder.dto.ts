import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class CreateFolderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  /** Parent folder; omit for a root folder. */
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
