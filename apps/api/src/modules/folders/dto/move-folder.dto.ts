import { IsUUID, ValidateIf } from "class-validator";

export class MoveFolderDto {
  /** New parent; null moves the folder to the root. */
  @ValidateIf((o: MoveFolderDto) => o.parentId !== null)
  @IsUUID()
  parentId!: string | null;
}
