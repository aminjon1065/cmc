import {
  proxyActivities,
  sleep,
  isCancellation,
  CancellationScope,
} from "@temporalio/workflow";
import type { CaseSlaActivities } from "../activities/case-sla.types";

/**
 * Case SLA-escalation workflow (P3.1 / ADR-0045). A durable timer per case:
 * sleep until the SLA target, then — if the case is still open — escalate.
 * Replaces the cron-based SLA sweep envisioned in P2.10.
 *
 * Determinism-safe: imports only `@temporalio/workflow` + a type-only activity
 * contract. No DB/Node code (that lives in the activities, run by the worker).
 *
 * Cancellation is the "case resolved early" path — the scheduler cancels this
 * workflow when the case leaves an open state; the sleep throws and we exit
 * without escalating. The activity status re-check is the belt-and-braces:
 * even if cancellation races the timer, we only escalate a still-open case.
 */
const { loadCaseStatus, escalateCase } = proxyActivities<CaseSlaActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});

export interface CaseSlaArgs {
  tenantId: string;
  caseId: string;
  /** Absolute SLA target (ISO-8601). */
  dueAtIso: string;
}

/** Statuses that still count as "needs work" → eligible for escalation. */
const OPEN_STATUSES = ["open", "triage", "in_progress"];

export async function caseSlaWorkflow(args: CaseSlaArgs): Promise<string> {
  // `Date.now()` inside a workflow is deterministic (replay-safe workflow time).
  const remainingMs = Date.parse(args.dueAtIso) - Date.now();

  try {
    await sleep(Math.max(remainingMs, 0));
  } catch (err) {
    if (isCancellation(err)) return "cancelled";
    throw err;
  }

  // The timer fired. Escalation must not be cancellable halfway, so run the
  // check + escalate in a non-cancellable scope.
  return CancellationScope.nonCancellable(async () => {
    const status = await loadCaseStatus(args.tenantId, args.caseId);
    if (!OPEN_STATUSES.includes(status)) return `skipped:${status}`;
    await escalateCase(args.tenantId, args.caseId);
    return "escalated";
  });
}
