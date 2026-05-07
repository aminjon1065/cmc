/**
 * Public contracts shared between apps/web (BFF) and apps/api (backend).
 *
 * Each domain gets its own file. Re-export from here so consumers import
 * a single, stable entry point: `import { HealthCheckResponse } from "@cmc/contracts"`.
 */

export * from "./health";
