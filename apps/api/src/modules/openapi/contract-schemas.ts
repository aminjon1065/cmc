import * as contracts from "@cmc/contracts";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";

type JsonSchema = Record<string, unknown>;

/**
 * Non-generic alias for `zodToJsonSchema`. Its real signature is generic over
 * the schema type, which TS tries to deeply resolve for each of the 64 distinct
 * contract schemas → "excessively deep instantiation" (TS2589). A flat
 * `(ZodTypeAny) => JsonSchema` signature is all we need and side-steps it.
 */
const toJsonSchema = zodToJsonSchema as unknown as (
  schema: z.ZodTypeAny,
  options?: { target?: "openApi3"; $refStrategy?: "none" },
) => JsonSchema;

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * Convert every exported `*Schema` Zod object in `@cmc/contracts` into an
 * OpenAPI 3.0 component schema (P1.10b / ADR-0028).
 *
 * The component name is the export name minus the trailing `Schema`
 * (`IncidentDetailResponseSchema` → `IncidentDetailResponse`), which matches the
 * TS type name each controller returns — so the operation→response map keys off
 * the same names. The Zod contracts are the single source of truth for response
 * shapes; this keeps the doc in lock-step with them (no hand-maintained DTOs to
 * drift).
 *
 * `$refStrategy: "none"` inlines nested schemas — our contracts are flat /
 * non-recursive, so there's nothing to share, and the output is self-contained
 * per component. `target: "openApi3"` matches the document's 3.0 dialect.
 */
export function buildContractComponentSchemas(): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  // Cast to `Record<string, unknown>` so values start as `unknown` — iterating
  // the typed namespace materialises a 64-member Zod union that trips TS's
  // "excessively deep instantiation" guard. The runtime `isZodSchema` check
  // then narrows each value safely.
  for (const [exportName, value] of Object.entries(
    contracts as Record<string, unknown>,
  )) {
    if (!exportName.endsWith("Schema") || !isZodSchema(value)) continue;
    const name = exportName.slice(0, -"Schema".length);
    const json = toJsonSchema(value, {
      target: "openApi3",
      $refStrategy: "none",
    });
    // Drop the JSON-Schema meta key — OpenAPI component schemas don't carry it.
    delete json.$schema;
    out[name] = json;
  }
  return out;
}
