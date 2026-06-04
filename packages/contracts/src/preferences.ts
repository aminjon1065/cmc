import { z } from "zod";

/**
 * Self-service UI preferences (ADR-0078) — persisted per user so the chosen
 * theme + locale follow them across browsers/devices. `GET/PATCH
 * /v1/me/preferences`. `null` = no explicit choice (the web falls back to the
 * light theme + RU locale defaults).
 */
export const UI_THEMES = ["light", "dark", "system"] as const;
export const UI_LOCALES = ["ru", "tg"] as const;
export type UiTheme = (typeof UI_THEMES)[number];
export type UiLocale = (typeof UI_LOCALES)[number];

export const UserPreferencesResponseSchema = z.object({
  theme: z.enum(UI_THEMES).nullable(),
  locale: z.enum(UI_LOCALES).nullable(),
});
export type UserPreferencesResponse = z.infer<
  typeof UserPreferencesResponseSchema
>;

/** PATCH body — omit a field to leave it unchanged; send `null` to clear it. */
export const UpdateUserPreferencesRequestSchema = z
  .object({
    theme: z.enum(UI_THEMES).nullable().optional(),
    locale: z.enum(UI_LOCALES).nullable().optional(),
  })
  .refine((v) => v.theme !== undefined || v.locale !== undefined, {
    message: "Provide at least one of theme, locale",
  });
export type UpdateUserPreferencesRequest = z.infer<
  typeof UpdateUserPreferencesRequestSchema
>;
