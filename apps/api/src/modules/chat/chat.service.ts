import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import {
  type ChatChannel,
  type ChatMessage,
  type ChatMessagesListResponse,
  type ChatReactionSummary,
  type CreateChatChannelRequest,
  type CreateChatMessageRequest,
  type UpdateChatMessageRequest,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import type { TenantTx } from "../database/tenant-database.service";
import { AuditService } from "../audit/audit.service";
import { OutboxService } from "../events/outbox.service";
import { RbacService } from "../rbac/rbac.service";
import { NotificationsService } from "../notifications/notifications.service";

type Actor = { tenantId: string; userId: string };
type MsgRow = typeof schema.chatMessages.$inferSelect;

/**
 * Chat service (P3.12 / ADR-0057). Tenant-open channels + messages, one-level
 * threads (`parent_id`), emoji reactions, and `@mention` → notifications. Every
 * mutation emits a `chat` event to the outbox in the SAME request tx (atomic) →
 * relay → NATS `tenant.<id>.chat.<eventType>.v1` → the P2.3 fan-out delivers it
 * live to `chat:read` subscribers. Author-or-`chat:manage` governs editing.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly rbac: RbacService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- channels ----------

  async createChannel(
    input: CreateChatChannelRequest,
    actor: Actor,
  ): Promise<ChatChannel> {
    const row = await this.tenantDb.run(async (tx) => {
      const [r] = await tx
        .insert(schema.chatChannels)
        .values({
          tenantId: actor.tenantId,
          name: input.name,
          description: input.description ?? null,
          createdBy: actor.userId,
        })
        .returning();
      await this.outbox.publish({
        tenantId: actor.tenantId,
        aggregateType: "chat",
        aggregateId: r!.id,
        eventType: "channel_created",
        payload: { channelId: r!.id, name: r!.name },
      });
      return r!;
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "chat.channel.created",
      resourceType: "chat_channel",
      resourceId: row.id,
      outcome: "success",
    });
    return this.toChannel(row);
  }

  async listChannels(): Promise<ChatChannel[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.chatChannels)
        .where(isNull(schema.chatChannels.deletedAt))
        .orderBy(schema.chatChannels.createdAt),
    );
    return rows.map((r) => this.toChannel(r));
  }

  async getChannel(id: string): Promise<ChatChannel> {
    return this.toChannel(await this.loadChannel(id));
  }

  async deleteChannel(id: string, actor: Actor): Promise<void> {
    await this.loadChannel(id);
    await this.tenantDb.run(async (tx) => {
      const now = new Date();
      await tx
        .update(schema.chatMessages)
        .set({ deletedAt: now })
        .where(
          and(
            eq(schema.chatMessages.channelId, id),
            isNull(schema.chatMessages.deletedAt),
          ),
        );
      await tx
        .update(schema.chatChannels)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(schema.chatChannels.id, id));
      await this.outbox.publish({
        tenantId: actor.tenantId,
        aggregateType: "chat",
        aggregateId: id,
        eventType: "channel_deleted",
        payload: { channelId: id },
      });
    });
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action: "chat.channel.deleted",
      resourceType: "chat_channel",
      resourceId: id,
      outcome: "success",
    });
  }

  // ---------- messages ----------

  async postMessage(
    channelId: string,
    input: CreateChatMessageRequest,
    actor: Actor,
  ): Promise<ChatMessage> {
    const channel = await this.loadChannel(channelId);
    const result = await this.tenantDb.run(async (tx) => {
      // Threads are one level deep: a reply's parent must be a top-level message
      // in this channel.
      if (input.parentId) {
        const [parent] = await tx
          .select()
          .from(schema.chatMessages)
          .where(
            and(
              eq(schema.chatMessages.id, input.parentId),
              isNull(schema.chatMessages.deletedAt),
            ),
          );
        if (!parent || parent.channelId !== channelId) {
          throw new BadRequestException("Parent message is not in this channel.");
        }
        if (parent.parentId) {
          throw new BadRequestException("Replies cannot be nested.");
        }
      }
      const [r] = await tx
        .insert(schema.chatMessages)
        .values({
          tenantId: actor.tenantId,
          channelId,
          parentId: input.parentId ?? null,
          authorId: actor.userId,
          body: input.body,
        })
        .returning();

      // Resolve @mentions to real tenant users (RLS scopes the lookup).
      let recipients: string[] = [];
      if (input.mentions?.length) {
        const found = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(inArray(schema.users.id, input.mentions));
        recipients = found
          .map((u) => u.id)
          .filter((id) => id !== actor.userId);
      }

      await this.outbox.publish({
        tenantId: actor.tenantId,
        aggregateType: "chat",
        aggregateId: r!.id,
        eventType: "message_created",
        payload: {
          channelId,
          messageId: r!.id,
          parentId: r!.parentId,
          authorId: actor.userId,
          body: r!.body,
          createdAt: r!.createdAt.toISOString(),
        },
      });
      return { row: r!, recipients };
    });

    // Mentions → notifications (best-effort; per-user failures are logged, not
    // thrown — never blocks the post).
    if (result.recipients.length) {
      await this.notifications.notifyUsers(actor.tenantId, result.recipients, {
        kind: "chat.mention",
        title: `Mentioned in #${channel.name}`,
        body: input.body.slice(0, 140),
        link: `/chat?channel=${channelId}`,
      });
    }
    return this.toMessage(result.row, [], 0);
  }

  async listMessages(
    channelId: string,
    actor: Actor,
    query: { limit?: number; before?: string },
  ): Promise<ChatMessagesListResponse> {
    await this.loadChannel(channelId);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const before = query.before ? new Date(query.before) : null;
    return this.tenantDb.run(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.channelId, channelId),
            isNull(schema.chatMessages.parentId), // top-level feed only
            isNull(schema.chatMessages.deletedAt),
            before ? lt(schema.chatMessages.createdAt, before) : undefined,
          ),
        )
        .orderBy(desc(schema.chatMessages.createdAt), desc(schema.chatMessages.id))
        .limit(limit);
      const asc = [...rows].reverse();
      const nextBefore =
        rows.length === limit && asc[0]
          ? asc[0].createdAt.toISOString()
          : null;
      const messages = await this.enrich(tx, asc, actor.userId);
      return { messages, nextBefore };
    });
  }

  async listReplies(
    messageId: string,
    actor: Actor,
  ): Promise<ChatMessagesListResponse> {
    await this.loadMessage(messageId);
    return this.tenantDb.run(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.parentId, messageId),
            isNull(schema.chatMessages.deletedAt),
          ),
        )
        .orderBy(schema.chatMessages.createdAt, schema.chatMessages.id)
        .limit(200);
      return { messages: await this.enrich(tx, rows, actor.userId), nextBefore: null };
    });
  }

  async updateMessage(
    messageId: string,
    input: UpdateChatMessageRequest,
    actor: Actor,
  ): Promise<ChatMessage> {
    const existing = await this.loadMessage(messageId);
    await this.assertAuthorOrManager(existing.authorId, actor);
    return this.tenantDb.run(async (tx) => {
      const now = new Date();
      const [r] = await tx
        .update(schema.chatMessages)
        .set({ body: input.body, editedAt: now, updatedAt: now })
        .where(eq(schema.chatMessages.id, messageId))
        .returning();
      await this.outbox.publish({
        tenantId: actor.tenantId,
        aggregateType: "chat",
        aggregateId: messageId,
        eventType: "message_updated",
        payload: { channelId: r!.channelId, messageId, body: r!.body },
      });
      const [enriched] = await this.enrich(tx, [r!], actor.userId);
      return enriched!;
    });
  }

  async deleteMessage(messageId: string, actor: Actor): Promise<void> {
    const existing = await this.loadMessage(messageId);
    await this.assertAuthorOrManager(existing.authorId, actor);
    await this.tenantDb.run(async (tx) => {
      const now = new Date();
      await tx
        .update(schema.chatMessages)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(schema.chatMessages.id, messageId));
      await this.outbox.publish({
        tenantId: actor.tenantId,
        aggregateType: "chat",
        aggregateId: messageId,
        eventType: "message_deleted",
        payload: { channelId: existing.channelId, messageId },
      });
    });
  }

  // ---------- reactions ----------

  async addReaction(
    messageId: string,
    emoji: string,
    actor: Actor,
  ): Promise<ChatMessage> {
    const msg = await this.loadMessage(messageId);
    return this.tenantDb.run(async (tx) => {
      await tx
        .insert(schema.chatReactions)
        .values({
          tenantId: actor.tenantId,
          messageId,
          userId: actor.userId,
          emoji,
        })
        .onConflictDoNothing();
      await this.outbox.publish({
        tenantId: actor.tenantId,
        aggregateType: "chat",
        aggregateId: messageId,
        eventType: "message_reacted",
        payload: { channelId: msg.channelId, messageId, emoji, userId: actor.userId },
      });
      const [enriched] = await this.enrich(tx, [msg], actor.userId);
      return enriched!;
    });
  }

  async removeReaction(
    messageId: string,
    emoji: string,
    actor: Actor,
  ): Promise<ChatMessage> {
    const msg = await this.loadMessage(messageId);
    return this.tenantDb.run(async (tx) => {
      await tx
        .delete(schema.chatReactions)
        .where(
          and(
            eq(schema.chatReactions.messageId, messageId),
            eq(schema.chatReactions.userId, actor.userId),
            eq(schema.chatReactions.emoji, emoji),
          ),
        );
      await this.outbox.publish({
        tenantId: actor.tenantId,
        aggregateType: "chat",
        aggregateId: messageId,
        eventType: "message_unreacted",
        payload: { channelId: msg.channelId, messageId, emoji, userId: actor.userId },
      });
      const [enriched] = await this.enrich(tx, [msg], actor.userId);
      return enriched!;
    });
  }

  // ---------- helpers ----------

  /** Attach reaction summaries + reply counts to a page of message rows. */
  private async enrich(
    tx: TenantTx,
    rows: MsgRow[],
    me: string,
  ): Promise<ChatMessage[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const reactRows = await tx
      .select({
        messageId: schema.chatReactions.messageId,
        emoji: schema.chatReactions.emoji,
        count: sql<number>`count(*)::int`,
        mine: sql<boolean>`bool_or(${schema.chatReactions.userId} = ${me})`,
      })
      .from(schema.chatReactions)
      .where(inArray(schema.chatReactions.messageId, ids))
      .groupBy(schema.chatReactions.messageId, schema.chatReactions.emoji);
    const replyRows = await tx
      .select({
        parentId: schema.chatMessages.parentId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.chatMessages)
      .where(
        and(
          inArray(schema.chatMessages.parentId, ids),
          isNull(schema.chatMessages.deletedAt),
        ),
      )
      .groupBy(schema.chatMessages.parentId);

    const reactions = new Map<string, ChatReactionSummary[]>();
    for (const r of reactRows) {
      const arr = reactions.get(r.messageId) ?? [];
      arr.push({ emoji: r.emoji, count: r.count, mine: r.mine });
      reactions.set(r.messageId, arr);
    }
    const replies = new Map<string, number>();
    for (const r of replyRows) if (r.parentId) replies.set(r.parentId, r.count);

    return rows.map((r) =>
      this.toMessage(r, reactions.get(r.id) ?? [], replies.get(r.id) ?? 0),
    );
  }

  private async loadChannel(
    id: string,
  ): Promise<typeof schema.chatChannels.$inferSelect> {
    const row = await this.tenantDb.run(async (tx) => {
      const [r] = await tx
        .select()
        .from(schema.chatChannels)
        .where(
          and(
            eq(schema.chatChannels.id, id),
            isNull(schema.chatChannels.deletedAt),
          ),
        );
      return r ?? null;
    });
    if (!row) throw new NotFoundException("Channel not found.");
    return row;
  }

  private async loadMessage(id: string): Promise<MsgRow> {
    const row = await this.tenantDb.run(async (tx) => {
      const [r] = await tx
        .select()
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.id, id),
            isNull(schema.chatMessages.deletedAt),
          ),
        );
      return r ?? null;
    });
    if (!row) throw new NotFoundException("Message not found.");
    return row;
  }

  private async assertAuthorOrManager(
    authorId: string | null,
    actor: Actor,
  ): Promise<void> {
    if (authorId && authorId === actor.userId) return;
    const canManage = await this.rbac.hasPermission(
      actor.tenantId,
      actor.userId,
      "chat:manage",
    );
    if (!canManage) {
      throw new ForbiddenException(
        "Only the author or a chat manager can do that.",
      );
    }
  }

  private toChannel(
    r: typeof schema.chatChannels.$inferSelect,
  ): ChatChannel {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private toMessage(
    r: MsgRow,
    reactions: ChatReactionSummary[],
    replyCount: number,
  ): ChatMessage {
    return {
      id: r.id,
      channelId: r.channelId,
      authorId: r.authorId,
      parentId: r.parentId,
      body: r.body,
      edited: r.editedAt !== null,
      replyCount,
      reactions,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
