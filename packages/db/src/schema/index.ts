/**
 * Re-exports every table defined under schema/. New tables MUST be added here
 * so Drizzle picks them up for migration generation and so consumers have a
 * single import surface.
 */
export * from "./tenants";
export * from "./tenant-branding";
export * from "./users";
export * from "./sessions";
export * from "./audit-log";
export * from "./audit-chain-anchor";
export * from "./audit-export-cursor";
export * from "./outbox";
export * from "./consumed-events";
export * from "./projection-cursors";
export * from "./folders";
export * from "./folder-grants";
export * from "./documents";
export * from "./document-versions";
export * from "./rbac";
export * from "./mfa";
export * from "./password-resets";
export * from "./incidents";
export * from "./notifications";
export * from "./user-notification-prefs";
export * from "./gis-layers";
export * from "./gis-features";
export * from "./cases";
export * from "./case-activity";
