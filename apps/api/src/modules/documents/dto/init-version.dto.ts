import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

export class InitVersionDto {
  @IsInt()
  @Min(1)
  sizeBytes!: number;

  /** Override the MIME type for this version; defaults to the document's. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^[a-z0-9!#$&\-^_.+]+\/[a-z0-9!#$&\-^_.+]+$/i, {
    message: "mimeType must be a valid IANA media type",
  })
  mimeType?: string;
}
