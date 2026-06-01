/**
 * Datalist suggestions for incident region/type/source (P1.5b).
 *
 * These are UI hints only — the API stores free text (ADR-0023), so this list
 * is non-binding and lives in the web (not the API/schema), keeping
 * jurisdiction specifics out of the backend (same principle as branding,
 * P0.11). A future tenant-configurable catalog would replace this.
 */

/** Regions of Tajikistan. */
export const REGION_SUGGESTIONS = [
  "Khatlon",
  "Sughd",
  "GBAO",
  "DRS",
  "Dushanbe",
] as const;

/** Common disaster / incident types. */
export const TYPE_SUGGESTIONS = [
  "Flood",
  "Mudflow",
  "Earthquake",
  "Landslide",
  "Avalanche",
  "Wildfire",
  "Drought",
  "Epidemic",
  "Industrial",
  "Infrastructure",
  "Other",
] as const;

/** Reporting sources. */
export const SOURCE_SUGGESTIONS = [
  "MNS",
  "DOR",
  "IGS",
  "Police",
  "Hydromet",
  "Public",
  "Other",
] as const;
