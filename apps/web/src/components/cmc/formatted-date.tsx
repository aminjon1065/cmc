"use client";

import { useFormatter } from "next-intl";
import { DATETIME_FORMAT, DATE_FORMAT, TIME_FORMAT } from "@/lib/datetime";

const PRESETS = {
  datetime: DATETIME_FORMAT,
  date: DATE_FORMAT,
  time: TIME_FORMAT,
} as const;

/**
 * Renders a timestamp in the active UI locale (RU/TG) via the next-intl
 * formatter. A tiny client island so it can be dropped into any component
 * (client or server parent) without threading `useFormatter` through it —
 * replaces locale-naive `new Date(x).toLocaleString()` call sites.
 */
export function FormattedDate({
  value,
  preset = "datetime",
}: {
  value: string | number | Date;
  preset?: keyof typeof PRESETS;
}) {
  const format = useFormatter();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return <>{format.dateTime(date, PRESETS[preset])}</>;
}
