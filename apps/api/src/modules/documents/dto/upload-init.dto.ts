import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class UploadInitDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  name!: string;

  // Permissive MIME validation: shape `type/subtype[+suffix]`. We don't
  // gate by an allowlist here — that's a policy decision per tenant in a
  // future iteration. For now any valid token is accepted.
  @IsString()
  @MaxLength(255)
  @Matches(/^[a-z0-9!#$&\-^_.+]+\/[a-z0-9!#$&\-^_.+]+$/i, {
    message: "mimeType must be a valid IANA media type",
  })
  mimeType!: string;

  @IsInt()
  @Min(1)
  sizeBytes!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** File the document into this folder on creation (P3.3). */
  @IsOptional()
  @IsUUID()
  folderId?: string;
}
