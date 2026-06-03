import type { Permission } from "@cmc/contracts";

/**
 * Per-subscription RBAC for the realtime gateway (P2.3b / ADR-0035). Maps an
 * event aggregate type — the 3rd subject token in
 * `tenant.<id>.<aggregateType>.<eventType>.v<n>` — to the permission a client
 * must hold to subscribe to that class of events.
 *
 * Fail-closed: an aggregate type with no entry here (or a wildcard in the
 * aggregate position, e.g. `tenant.<id>.>` / `tenant.<id>.*.…`) has no mapping,
 * so the subscription is rejected. A client can therefore only ever receive
 * event classes it is explicitly authorised for, and a client must name the
 * aggregate type rather than wildcard across all of them.
 */
export const SUBJECT_AGGREGATE_PERMISSION: Readonly<
  Record<string, Permission>
> = {
  incident: "incident:read",
  // Chat realtime (P3.12): subscribe to `tenant.<id>.chat.>` with chat:read to
  // receive channel/message events fanned out from the outbox.
  chat: "chat:read",
};

/** The permission required to subscribe to `subject`, or null if not allowed. */
export function requiredPermissionForSubject(
  subject: string,
): Permission | null {
  const aggregateType = subject.split(".")[2];
  if (!aggregateType) return null;
  return SUBJECT_AGGREGATE_PERMISSION[aggregateType] ?? null;
}
