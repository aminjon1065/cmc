/**
 * NATS-style subject matching for the realtime gateway (P2.3 / ADR-0035).
 * Subjects are dot-separated token lists, e.g.
 * `tenant.<id>.incident.created.v1`. Subscription patterns may use:
 *   - `*` to match exactly one token, and
 *   - `>` to match one or more trailing tokens (only as the final token).
 */

/** True if `subject` matches the subscription `pattern` (NATS semantics). */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    const tok = p[i];
    if (tok === ">") {
      // Tail wildcard: matches the remaining tokens (at least one).
      return s.length > i;
    }
    if (i >= s.length) return false;
    if (tok === "*") continue; // single-token wildcard
    if (tok !== s[i]) return false;
  }
  return p.length === s.length;
}

/**
 * Tenant-isolation guard for subscriptions. A connection may only subscribe to
 * subjects confined to its OWN tenant: the pattern must begin with the literal
 * `tenant.<tenantId>` (no wildcard in the tenant position). This rejects
 * cross-tenant subjects (`tenant.<other>.…`), wildcard-tenant fan-outs
 * (`tenant.*.…`, `tenant.>`), and platform/system subjects (`tenant.system.…`).
 */
export function isSubjectWithinTenant(
  pattern: string,
  tenantId: string,
): boolean {
  const p = pattern.split(".");
  return p.length >= 2 && p[0] === "tenant" && p[1] === tenantId;
}
