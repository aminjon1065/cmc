/**
 * Public contracts shared between apps/web (BFF) and apps/api (backend).
 *
 * Each domain gets its own file. Re-export from here so consumers import
 * a single, stable entry point: `import { HealthCheckResponse } from "@cmc/contracts"`.
 */

export * from "./health";
export * from "./auth";
export * from "./documents";
export * from "./region";
export * from "./branding";
export * from "./rbac";
export * from "./mfa";
export * from "./password-reset";
export * from "./users";
export * from "./tenants";
export * from "./incident";
export * from "./case";
export * from "./notification";
export * from "./audit";
export * from "./events";
export * from "./realtime";
export * from "./analytics";
export * from "./gis";
export * from "./search";
export * from "./folder";
export * from "./import";
export * from "./chat";
export * from "./llm";
export * from "./vector";
export * from "./rag";
export * from "./copilot";
export * from "./backup";
export * from "./preferences";
