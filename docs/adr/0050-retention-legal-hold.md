# ADR-0050: Document retention policies + legal hold

**Status:** Accepted
**Date:** 2026-06-02
**Implements:** PRIORITY_EXECUTION_PLAN P3.5
**Depends on:** documents (P0.10), folders (P3.3), versioning (P3.4), audit (P1.11), @nestjs/schedule

## Context

ToR §9 retention: documents should expire on a policy, with legal hold to
suspend expiry/deletion for matters under investigation. Three points were
confirmed with the user: **per-folder rule inherited (+ per-doc override)**,
**soft-delete on expiry**, and a **@nestjs/schedule daily sweep**.

## Decision

### Where rules live + effective retention

`folders.retention_days` (a policy that **inherits down** the ltree subtree) and
`documents.retention_days` (a per-document **override**; null = inherit). The
effective retention for a document is `COALESCE(doc.retention_days, <nearest
ancestor folder with a non-null policy>)`. With ltree the "nearest ancestor" is
`SELECT retention_days FROM folders g WHERE docFolder.path <@ g.path AND
g.retention_days IS NOT NULL ORDER BY nlevel(g.path) DESC LIMIT 1`. A document
with no override and no covering folder policy has **no retention** (kept).

Expiry anchor is `updated_at`: a document expires when
`updated_at + retain·days < now()`.

### Legal hold

`documents.legal_hold` (boolean). While held, the document is **skipped by the
sweep** and **manual `DELETE` returns 403**. Set/cleared via
`POST /documents/:id/legal-hold` (audited).

### Sweeper: gated daily cron + manual flush

`RetentionService.@Cron(EVERY_DAY_AT_2AM)` runs only when `RETENTION_ENABLED`
(off by default, so an automated delete never surprises a deploy) — mirroring the
audit Merkle-anchor cron. The sweep is one privileged CTE (cross-tenant, or
scoped) that soft-deletes (`deleted_at = now()`) every ready, non-held,
expired document and writes **one `document.retention_sweep` audit row per
affected tenant** (the per-document deletions are visible via `deleted_at`; the
async sealer chains the audit rows). A manual `POST /documents/retention/sweep`
(`document:delete`) runs the sweep scoped to the caller's tenant — always, even
with the cron disabled.

### Policy endpoints

`PATCH /folders/:id/retention` (`folder:write`), `POST /documents/:id/retention`
(`document:write`). The `Document` contract gains `retentionDays` + `legalHold`;
`Folder` gains `retentionDays`. Retention/hold endpoints inherit the folder-access
checks (P3.3b) where the document is filed.

## Consequences

**Positive**
- Set a retention policy once on a folder; everything under it inherits, with a
  per-document escape hatch. Legal hold cleanly freezes deletion for holds.
- Soft-delete is reversible/auditable; nothing is irreversibly destroyed by an
  automated sweep. Off-by-default cron + manual flush is safe + testable.
- Verified end-to-end: inherited policy soft-deletes an expired doc; no-policy
  kept; per-doc override wins; legal hold suspends the sweep + blocks manual
  delete; API surfaces the fields.

**Negative / deferred**
- **Soft-delete only** — expired objects' bytes are retained; a hard-purge job
  to reclaim storage (respecting versions) is a follow-on.
- **Legal hold is per-document** — no folder-level (inherited) hold yet; set via
  `document:write` (no dedicated compliance-officer permission yet).
- **Anchor = `updated_at`** — re-filing / metadata edits reset the clock; an
  explicit per-document expiry date is a future option.
- **Sweep audit is per-tenant summary**, not a row per deleted document.
- No retention to GIS/cases/incidents (documents only).

## Validation

- **Suite**: 320/320, 42 suites (+6). `documents-retention`: inherited folder
  policy soft-deletes an expired doc; no-policy kept; per-doc override beats the
  folder policy; legal hold suspends the sweep; legal hold → manual delete 403
  (then lift → 204); `retentionDays`/`legalHold` set + surfaced via the API. Real
  Postgres + ltree.
- **Build/lint**: contracts + db + API `tsc`, `nest build`, `eslint` clean.
  Migration `0024` (`folders.retention_days`, `documents.retention_days` +
  `legal_hold`).
