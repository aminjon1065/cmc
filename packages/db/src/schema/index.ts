/**
 * Re-exports every table defined under schema/. New tables MUST be added here
 * so Drizzle picks them up for migration generation and so consumers have a
 * single import surface.
 */
export * from "./tenants";
export * from "./tenant-branding";
export * from "./regions";
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
export * from "./workflows";
export * from "./workflow-runs";
export * from "./api-keys";
export * from "./wiki-spaces";
export * from "./wiki-pages";
export * from "./wiki-page-versions";
export * from "./wiki-comments";
export * from "./import-jobs";
export * from "./import-row-errors";
export * from "./chat-channels";
export * from "./chat-messages";
export * from "./chat-reactions";
export * from "./collab-docs";
export * from "./video-rooms";
export * from "./video-recordings";
export * from "./media-assets";
