import { z } from "zod";

/**
 * Notification contracts (P1.6 / ADR-0024).
 *
 * In-app notifications are self-scoped: every endpoint acts on the current
 * user's own notifications (no permission needed, like `/rbac/me`).
 */

export const NOTIFICATION_KINDS = [
  "incident.assigned",
  "incident.transitioned",
  // Incident-response workflow (P3.2 / ADR-0046): the responder page + reminders,
  // and the unacknowledged-escalation fan-out.
  "incident.response",
  "incident.escalated",
  // Visual-workflow notify node (P3.8 / ADR-0053).
  "workflow.notify",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NotificationSummarySchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type NotificationSummary = z.infer<typeof NotificationSummarySchema>;

export const NotificationsListResponseSchema = z.object({
  notifications: z.array(NotificationSummarySchema),
  unreadCount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type NotificationsListResponse = z.infer<
  typeof NotificationsListResponseSchema
>;

export const UnreadCountResponseSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
});
export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;

// ---------- preferences (P1.6c) ----------

export const NotificationPrefSchema = z.object({
  kind: z.string(),
  inApp: z.boolean(),
  email: z.boolean(),
});
export type NotificationPref = z.infer<typeof NotificationPrefSchema>;

export const NotificationPrefsResponseSchema = z.object({
  preferences: z.array(NotificationPrefSchema),
});
export type NotificationPrefsResponse = z.infer<
  typeof NotificationPrefsResponseSchema
>;

export const UpdateNotificationPrefRequestSchema = z.object({
  inApp: z.boolean(),
  email: z.boolean(),
});
export type UpdateNotificationPrefRequest = z.infer<
  typeof UpdateNotificationPrefRequestSchema
>;
