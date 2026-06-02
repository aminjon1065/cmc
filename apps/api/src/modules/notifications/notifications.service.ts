import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import {
  NOTIFICATION_KINDS,
  type IncidentDetail,
  type IncidentStatus,
  type NotificationKind,
  type NotificationPrefsResponse,
  type NotificationSummary,
  type NotificationsListResponse,
} from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { MailService } from "../../common/mail/mail.service";
import { buildNotificationEmail } from "../../common/mail/templates";

type Actor = { userId: string; tenantId: string };
type NotificationRow = typeof schema.notifications.$inferSelect;

/**
 * In-app notifications (P1.6 / ADR-0024).
 *
 * Reads are **self-scoped**: every list/count/mark acts on `userId` (the
 * caller), on top of RLS tenant isolation. Dispatch (from IncidentsService) is
 * **best-effort** — it opens its own tenant transaction (so it's isolated from
 * the triggering operation) and never throws, so a notification hiccup can't
 * fail an incident mutation.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly appBaseUrl: string;

  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly mail: MailService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.appBaseUrl = config.get("APP_BASE_URL", { infer: true });
  }

  // ---------- dispatch (best-effort, own tx, never throws) ----------

  private async create(input: {
    tenantId: string;
    userId: string;
    kind: NotificationKind;
    title: string;
    body?: string | null;
    link?: string | null;
  }): Promise<void> {
    await this.tenantDb.runForTenant(input.tenantId, async (tx) => {
      // Per-user, per-kind preferences (missing row → both channels on).
      const pref = (
        await tx
          .select({
            inApp: schema.userNotificationPrefs.inApp,
            email: schema.userNotificationPrefs.email,
          })
          .from(schema.userNotificationPrefs)
          .where(
            and(
              eq(schema.userNotificationPrefs.userId, input.userId),
              eq(schema.userNotificationPrefs.kind, input.kind),
            ),
          )
          .limit(1)
      )[0];
      const wantInApp = pref?.inApp ?? true;
      const wantEmail = pref?.email ?? true;

      let notifId: string | null = null;
      if (wantInApp) {
        const [row] = await tx
          .insert(schema.notifications)
          .values({
            tenantId: input.tenantId,
            userId: input.userId,
            kind: input.kind,
            title: input.title,
            body: input.body ?? null,
            link: input.link ?? null,
          })
          .returning({ id: schema.notifications.id });
        notifId = row!.id;
      }

      if (wantEmail) {
        const recipient = (
          await tx
            .select({ email: schema.users.email })
            .from(schema.users)
            .where(eq(schema.users.id, input.userId))
            .limit(1)
        )[0];
        if (recipient?.email) {
          const { subject, html, text } = buildNotificationEmail({
            title: input.title,
            body: input.body,
            url: input.link ? `${this.appBaseUrl}${input.link}` : null,
          });
          const sent = await this.mail.send({
            to: recipient.email,
            subject,
            html,
            text,
          });
          if (sent && notifId) {
            await tx
              .update(schema.notifications)
              .set({ dispatchedAt: sql`now()` })
              .where(eq(schema.notifications.id, notifId));
          }
        }
      }
    });
  }

  // ---------- preferences ----------

  /** The user's per-kind preferences, defaulting missing kinds to both-on. */
  async getPrefs(userId: string): Promise<NotificationPrefsResponse> {
    return this.tenantDb.run(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.userNotificationPrefs)
        .where(eq(schema.userNotificationPrefs.userId, userId));
      const byKind = new Map(rows.map((r) => [r.kind, r]));
      return {
        preferences: NOTIFICATION_KINDS.map((kind) => {
          const r = byKind.get(kind);
          return { kind, inApp: r?.inApp ?? true, email: r?.email ?? true };
        }),
      };
    });
  }

  /** Upsert one (user, kind) preference. */
  async setPref(
    userId: string,
    tenantId: string,
    kind: string,
    pref: { inApp: boolean; email: boolean },
  ): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .insert(schema.userNotificationPrefs)
        .values({
          userId,
          tenantId,
          kind,
          inApp: pref.inApp,
          email: pref.email,
        })
        .onConflictDoUpdate({
          target: [
            schema.userNotificationPrefs.userId,
            schema.userNotificationPrefs.kind,
          ],
          set: { inApp: pref.inApp, email: pref.email, updatedAt: sql`now()` },
        }),
    );
  }

  private async fanOut(
    tenantId: string,
    recipients: string[],
    n: { kind: NotificationKind; title: string; body?: string; link?: string },
  ): Promise<void> {
    for (const userId of [...new Set(recipients)]) {
      try {
        await this.create({ tenantId, userId, ...n });
      } catch (err) {
        this.logger.warn(
          `notification dispatch failed for user ${userId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Notify the new assignee (unless they assigned it to themselves). */
  async incidentAssigned(incident: IncidentDetail, actor: Actor): Promise<void> {
    const assignee = incident.assignedTo?.id;
    if (!assignee || assignee === actor.userId) return;
    await this.fanOut(actor.tenantId, [assignee], {
      kind: "incident.assigned",
      title: `Assigned to you: ${incident.summary}`,
      body: `SEV-${incident.severity} · ${incident.region} · ${incident.type}`,
      link: `/incidents/${incident.id}`,
    });
  }

  /** Notify the reporter + assignee of a status change (excluding the actor). */
  async incidentTransitioned(
    incident: IncidentDetail,
    from: IncidentStatus,
    to: IncidentStatus,
    actor: Actor,
  ): Promise<void> {
    const recipients = [incident.reportedBy?.id, incident.assignedTo?.id].filter(
      (id): id is string => Boolean(id) && id !== actor.userId,
    );
    if (recipients.length === 0) return;
    await this.fanOut(actor.tenantId, recipients, {
      kind: "incident.transitioned",
      title: `Incident ${to}: ${incident.summary}`,
      body: `Status ${from} → ${to}`,
      link: `/incidents/${incident.id}`,
    });
  }

  /**
   * Fan a notification out to an explicit recipient list (P3.2 / ADR-0046).
   * Public seam for workflow activities (incident-response page / reminder /
   * escalation) — dedups recipients, per-user failures are logged not thrown.
   */
  async notifyUsers(
    tenantId: string,
    recipients: string[],
    n: { kind: NotificationKind; title: string; body?: string; link?: string },
  ): Promise<void> {
    await this.fanOut(tenantId, recipients, n);
  }

  // ---------- read (self-scoped) ----------

  async listForUser(
    userId: string,
    opts: { unreadOnly?: boolean; limit?: number; offset?: number },
  ): Promise<NotificationsListResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);

    return this.tenantDb.run(async (tx) => {
      const conds = [eq(schema.notifications.userId, userId)];
      if (opts.unreadOnly) conds.push(isNull(schema.notifications.readAt));
      const where = and(...conds);

      const rows = await tx
        .select()
        .from(schema.notifications)
        .where(where)
        .orderBy(desc(schema.notifications.createdAt))
        .limit(limit)
        .offset(offset);

      const totalRows = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(schema.notifications)
        .where(where);
      const unreadRows = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, userId),
            isNull(schema.notifications.readAt),
          ),
        );

      return {
        notifications: rows.map((r) => this.toSummary(r)),
        unreadCount: unreadRows[0]?.value ?? 0,
        total: totalRows[0]?.value ?? 0,
        limit,
        offset,
      };
    });
  }

  async unreadCount(userId: string): Promise<number> {
    return this.tenantDb.run(async (tx) => {
      const rows = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, userId),
            isNull(schema.notifications.readAt),
          ),
        );
      return rows[0]?.value ?? 0;
    });
  }

  /** Mark one of the user's own notifications read (idempotent). */
  async markRead(userId: string, id: string): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.notifications)
        .set({ readAt: sql`now()` })
        .where(
          and(
            eq(schema.notifications.id, id),
            eq(schema.notifications.userId, userId),
            isNull(schema.notifications.readAt),
          ),
        ),
    );
  }

  async markAllRead(userId: string): Promise<void> {
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.notifications)
        .set({ readAt: sql`now()` })
        .where(
          and(
            eq(schema.notifications.userId, userId),
            isNull(schema.notifications.readAt),
          ),
        ),
    );
  }

  private toSummary(row: NotificationRow): NotificationSummary {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
