/**
 * Shared next-intl date/time format presets (locale-aware: RU default + TG).
 *
 * The app previously rendered dates with locale-naive `toLocaleString()` etc.,
 * which formats in the server/browser default locale (en-US) regardless of the
 * user's chosen UI language. These presets are fed to the next-intl formatter
 * so timestamps follow the active `NEXT_LOCALE`:
 *
 *   client component:  const format = useFormatter();
 *                      format.dateTime(new Date(iso), DATETIME_FORMAT)
 *   server component:  const format = await getFormatter();
 *                      format.dateTime(new Date(iso), DATETIME_FORMAT)
 *
 * ICU ships full data for both `ru` and `tg` (Cyrillic month names), so e.g.
 * 2026-06-05T19:07 renders "5 июн. 2026 г., 19:07" (ru) / "05 Июн 2026, 19:07" (tg).
 */
export const DATETIME_FORMAT = {
  dateStyle: "medium",
  timeStyle: "short",
} as const;

export const DATE_FORMAT = { dateStyle: "medium" } as const;

export const TIME_FORMAT = { timeStyle: "short" } as const;
