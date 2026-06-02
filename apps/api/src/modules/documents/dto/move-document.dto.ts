import { IsUUID, ValidateIf } from "class-validator";

export class MoveDocumentDto {
  /** Target folder; null unfiles the document (P3.3). */
  @ValidateIf((o: MoveDocumentDto) => o.folderId !== null)
  @IsUUID()
  folderId!: string | null;
}
