/**
 * Re-exports every table defined under schema/. New tables MUST be added here
 * so Drizzle picks them up for migration generation and so consumers have a
 * single import surface.
 */
export * from "./tenants";
export * from "./users";
export * from "./sessions";
export * from "./audit-log";
