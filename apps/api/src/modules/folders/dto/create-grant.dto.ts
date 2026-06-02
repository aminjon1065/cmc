import { IsIn, IsUUID } from "class-validator";
import {
  FOLDER_ACCESS_LEVELS,
  FOLDER_GRANT_SUBJECT_TYPES,
  type FolderAccessLevel,
  type FolderGrantSubjectType,
} from "@cmc/contracts";

export class CreateGrantDto {
  @IsIn(FOLDER_GRANT_SUBJECT_TYPES as readonly string[])
  subjectType!: FolderGrantSubjectType;

  @IsUUID()
  subjectId!: string;

  @IsIn(FOLDER_ACCESS_LEVELS as readonly string[])
  access!: FolderAccessLevel;
}
