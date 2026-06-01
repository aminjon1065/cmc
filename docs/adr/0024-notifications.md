# ADR-0024: Notifications

**Status:** Accepted (P1.6 complete — all three phases a–c shipped 2026-06-01)
**Date:** 2026-06-01
**Implements:** PRIORITY_EXECUTION_PLAN P1.6
**Depends on:** ADR-0003 (RLS), ADR-0023 (incidents — the first trigger source)
**Unblocks:** P1.6c email (swaps the P1.3 password-reset dev-logger for SMTP)

## Context

The moment incidents have owners, those owners must be told when something
happens. P1.6 adds a notification system: in-app first (P1.6a), then a web
center (P1.6b), then an email channel (P1.6c) that also closes the P1.3
password-reset email gap. This ADR covers the in-app foundation + dispatch.

## Decision

### 1. `notifications` table — one row per (recipient, event)

`notifications` carries `tenant_id`, `user_id` (recipient), `kind`
(e.g. `incident.assigned`), `title`, `body?`, `link?` (in-app deep link),
`read_at`, `dispatched_at` (when the email channel fired — P1.6c, null until
then), `created_at`. Tenant-isolated via RLS (two-GUC, ADR-0003); the service
additionally scopes every read/write to `user_id`, so per-user privacy is
enforced in the application layer on top of tenant isolation.

### 2. Self-scoped center — no permissions

`GET /notifications` (list + `unreadCount`), `GET /notifications/unread-count`,
`POST /notifications/:id/read`, `POST /notifications/read-all` act on the
**current user's own** notifications — authenticated but not `@Authorize`-gated
(like `/rbac/me`). Mark-read is idempotent and only ever touches the caller's
own rows (`WHERE user_id = me AND read_at IS NULL`).

### 3. Direct, best-effort dispatch (no event bus yet)

`IncidentsService` calls `NotificationsService` directly after a mutation
commits its work — the spec's "initially direct service-call". Dispatch is
**best-effort and isolated**:

- It opens its **own** tenant transaction (`runForTenant`) rather than joining
  the request transaction, so a notification insert can't roll back the
  incident change, and it commits independently.
- It **never throws** — `fanOut` catches per-recipient and logs, so a
  notification hiccup can't fail the incident operation.

Recipients exclude the actor (you don't get notified of your own action):

- **assign** → the new assignee (if not self).
- **transition** → the reporter + assignee (minus the actor).

A transactional outbox + a worker (for true after-commit delivery and retries)
is the future hardening; an event bus (Redis/queue) is deferred until a second
producer exists.

### 4. Module wiring — no cycle

`IncidentsModule` imports `NotificationsModule` (one direction;
NotificationsModule doesn't depend on incidents), so injecting
`NotificationsService` into `IncidentsService` is clean. The notification
`kind`s reference incident events as strings — the notifications module has no
compile dependency on the incident domain beyond the shared contract types.

## P1.6b — Web notification center (delivered 2026-06-01)

- **Topbar bell** (`NotificationBell`, client): an unread badge over the bell,
  a dropdown of the latest 8 notifications (unread-highlighted, relative time,
  deep-link on click → marks read + navigates), and a "Mark all read" action.
  The badge **polls** `GET /notifications/unread-count` every 30s (no socket
  yet); initial count + items are server-rendered by the topbar so the first
  paint is correct with no flash.
- **`/notifications` page**: the full list (latest 50) with per-row mark-read
  (click → navigate) and mark-all. Linked from the dropdown's "See all" and the
  sidebar's now-enabled "Notifications" entry (open to every authenticated
  user). Middleware protects `/notifications`.
- **Server actions, not client fetch:** the client components call server
  actions (`getUnreadCountAction`, `getNotificationsAction`, `markReadAction`,
  `markAllReadAction`) which use the server-only `authedApiFetch` — the session
  token never leaves the server. All fail-safe (count → 0, list → empty) so a
  blip never breaks the chrome.
- **Validated:** web typecheck + production build green (`/notifications`
  compiles; the bell ships on every authed page via the topbar) + lint clean.
  Backend unchanged → suite stays **159/159**.

## P1.6c — Email channel + preferences (delivered 2026-06-01)

- **MailService** (`common/mail`, `@Global`): Nodemailer over `MAIL_*`. Best-
  effort — `send` NEVER throws. When mail is disabled/unconfigured it **logs in
  dev** (so a reset link is visible without an SMTP server) but **warns + drops
  in production** — preserving the P1.3 rule that reset links never hit prod
  stdout. Dev points `MAIL_*` at **Mailpit** (compose: SMTP 1025, web UI 8025),
  which catches everything locally; prod points at a real SMTP server.
- **Password-reset email — closes the P1.3 gap.** The `PASSWORD_RESET_NOTIFIER`
  binding swapped from the dev-logger to `EmailResetNotifier` (MailService +
  an HTML template). Self-service reset now actually emails the link. Verified
  live: a forgot-password landed a "Reset your CMC password" email in Mailpit
  with the working token link.
- **Email on notification.** `NotificationsService.create` now also emails the
  recipient (generic notification template, absolute `APP_BASE_URL` deep-link)
  and stamps `dispatched_at` on success. Verified live: an incident assignment
  produced both an in-app row and an "Assigned to you" email with a
  `/incidents/<id>` link.
- **Per-user preferences.** `user_notification_prefs` (user, kind → `in_app`,
  `email`; missing row = both on) under RLS + migration `0011`. `create`
  consults them: in-app off → no row, email off → no send. Self-scoped
  endpoints `GET /notifications/preferences` + `PUT /notifications/
  preferences/:kind`; a web toggle grid on `/notifications`.
- **Simple HTML templates** (template literals, inline styles, HTML-escaped) —
  no MJML toolchain, per the scope decision.
- **Validated:** +5 e2e (email-on-assign / email-pref-off-suppresses-email /
  in-app-pref-off-suppresses-row / prefs-defaults / unknown-kind-400) with a
  capturing MailService; suite **164/164**; web build + lint green; live-smoke
  of both the password-reset and incident emails through Mailpit.

## P1.6 complete

All three phases shipped: **a** in-app + dispatch · **b** web center · **c**
email + preferences. Notifications now reach incident owners in-app and by
email, gated by per-user preferences, and the long-standing P1.3 password-reset
email gap is closed. Deferred (tracked): transactional outbox + worker, event
bus, MJML, quiet-hours, Web Push, webhooks.

## Consequences

**Positive:**

- Incident owners are now informed: assign + status changes fan out in-app +
  email, scoped to the right people, never to the actor, honoring preferences.
- A live bell + center: the unread badge updates on a poll, and the dropdown
  deep-links straight to the incident.
- The P1.3 password-reset email gap is closed — self-service reset works end to
  end through SMTP (Mailpit in dev).
- Best-effort + own-transaction dispatch means notifications can't destabilise
  the incident flow — the core operation always succeeds first.
- Self-scoped endpoints need no new permissions; the center is private by
  construction (RLS + user_id filter).
- Verified: 6 e2e (assign-notifies-assignee-not-actor / self-assign-no-one /
  transition-notifies-reporter+assignee-minus-actor / self-scoped / mark-read +
  read-all / 401); full suite **159/159**; live-smoke wrote real rows on the
  dev DB for assign + transition.

**Negative / known gaps:**

- **No email yet** — in-app only; P1.6c adds the SMTP channel (and wires the
  P1.3 password-reset notifier to it). `dispatched_at` is reserved for that.
- **No preferences** — every eligible recipient gets every in-app notification;
  per-kind in-app/email on/off arrives with P1.6c.
- **Best-effort, not guaranteed** — a dispatch that fails (e.g. DB blip) is
  logged and dropped, not retried. The outbox+worker upgrade is future work.
- **Direct coupling** — `IncidentsService` knows about `NotificationsService`.
  Fine for one producer; revisit with an event bus when there are several.
- **Limited kinds** — only `incident.assigned` + `incident.transitioned`.
  `incident.created` has no clear recipient without a duty roster (future).

## Triggers for re-evaluation

- P1.6c email → add the SMTP channel + `user_notification_prefs`; set
  `dispatched_at`; reuse this dispatch path for the password-reset email.
- A second event producer (cases, tasks…) → introduce an event bus / outbox so
  producers don't import every consumer.
- Volume/reliability needs → transactional outbox + worker with retries.

## References

- [PRIORITY_EXECUTION_PLAN P1.6](../audit/PRIORITY_EXECUTION_PLAN.md)
- [ADR-0023](./0023-incidents.md) — the first trigger source
- [ADR-0021](./0021-password-reset.md) — the notifier P1.6c will move onto SMTP
- ToR §3.13 (Notification System)
