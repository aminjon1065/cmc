import { IsIn, IsOptional } from "class-validator";
import { UI_LOCALES, UI_THEMES } from "@cmc/contracts";

/**
 * PATCH /v1/me/preferences body. Both fields optional; `null` clears the
 * preference, a valid enum sets it. `@IsOptional` skips validation for
 * null/undefined so "clear" is allowed; the global ValidationPipe
 * (whitelist + forbidNonWhitelisted) rejects any other key.
 */
export class UpdatePreferencesDto {
  @IsOptional()
  @IsIn([...UI_THEMES])
  theme?: (typeof UI_THEMES)[number] | null;

  @IsOptional()
  @IsIn([...UI_LOCALES])
  locale?: (typeof UI_LOCALES)[number] | null;
}
