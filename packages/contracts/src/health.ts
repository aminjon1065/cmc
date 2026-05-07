import { z } from "zod";

/**
 * Health check response — returned by the API's `/health` endpoint and consumed
 * by the web app's status panel. Validated at both ends with the same schema.
 */
export const HealthCheckResponseSchema = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string().datetime(),
});

export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;
