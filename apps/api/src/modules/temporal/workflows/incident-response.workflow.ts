import {
  proxyActivities,
  sleep,
  isCancellation,
  CancellationScope,
} from "@temporalio/workflow";
import type { IncidentResponseActivities } from "../activities/incident-response.types";

/**
 * Incident-response workflow (P3.2 / ADR-0046). For a high-severity incident:
 * page the responders, then loop — sleeping a reminder interval at a time up to
 * the ack SLA — reminding while the incident stays unacknowledged. If still
 * unacknowledged when the SLA elapses, escalate. "Acknowledged" = the incident
 * has left the `reported` state (someone triaged / picked it up).
 *
 * Determinism-safe: only `@temporalio/workflow` + a type-only activity contract.
 * Cancellable (the scheduler cancels when the incident resolves/closes); the
 * per-step status re-check is the belt-and-braces against a cancel/timer race.
 */
const { loadIncidentStatus, notifyResponders, escalateIncident } =
  proxyActivities<IncidentResponseActivities>({
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 5 },
  });

export interface IncidentResponseArgs {
  tenantId: string;
  incidentId: string;
  ackSlaSec: number;
  reminderIntervalSec: number;
}

/** While the incident sits here it is unacknowledged → response stays active. */
const UNACKNOWLEDGED = "reported";

export async function incidentResponseWorkflow(
  args: IncidentResponseArgs,
): Promise<string> {
  const deadlineMs = args.ackSlaSec * 1000;
  const intervalMs = args.reminderIntervalSec * 1000;

  try {
    await notifyResponders(args.tenantId, args.incidentId, "page");

    let elapsed = 0;
    while (elapsed < deadlineMs) {
      const step = Math.min(intervalMs, deadlineMs - elapsed);
      await sleep(step);
      elapsed += step;

      const status = await loadIncidentStatus(args.tenantId, args.incidentId);
      if (status !== UNACKNOWLEDGED) return `stopped:${status}`;

      // Remind on intermediate ticks, not the one that lands on the deadline
      // (escalation follows immediately after the loop).
      if (elapsed < deadlineMs) {
        await notifyResponders(args.tenantId, args.incidentId, "reminder");
      }
    }
  } catch (err) {
    if (isCancellation(err)) return "cancelled";
    throw err;
  }

  // SLA elapsed — escalate, but only if still unacknowledged. Non-cancellable so
  // the escalation can't be torn in half.
  return CancellationScope.nonCancellable(async () => {
    const status = await loadIncidentStatus(args.tenantId, args.incidentId);
    if (status !== UNACKNOWLEDGED) return `stopped:${status}`;
    await escalateIncident(args.tenantId, args.incidentId);
    return "escalated";
  });
}
