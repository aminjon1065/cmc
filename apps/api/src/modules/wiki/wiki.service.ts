import { randomUUID } from "crypto";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type {
  CreateWikiCommentRequest,
  CreateWikiPageRequest,
  CreateWikiSpaceRequest,
  MoveWikiPageRequest,
  ProseMirrorDoc,
  UpdateWikiPageRequest,
  UpdateWikiSpaceRequest,
  WikiComment,
  WikiPage,
  WikiPageSummary,
  WikiPageVersion,
  WikiSpace,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { TenantContextService } from "../../common/tenant-context/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";

type SpaceRow = typeof schema.wikiSpaces.$inferSelect;
type PageRow = typeof schema.wikiPages.$inferSelect;
type CommentRow = typeof schema.wikiComments.$inferSelect;

/** UUID → ltree-safe label (hyphens aren't valid in ltree labels). */
function label(id: string): string {
  return id.replace(/-/g, "");
}

const EMPTY_DOC: ProseMirrorDoc = { type: "doc", content: [] };

/** Flatten a ProseMirror/TipTap doc to plaintext (search + snippets). */
function extractText(doc: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    const node = n as { type?: string; text?: string; content?: unknown[] };
    if (node.type === "text" && typeof node.text === "string")
      parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  return parts.join(" ").slice(0, 100_000);
}

/**
 * Wiki spaces + pages (P3.10 / ADR-0055). Pages form an ltree tree per space;
 * content is TipTap JSON with a derived plaintext; every save snapshots a
 * version. Tenant-wide `wiki:*` RBAC gates the controller; RLS confines all
 * rows to the tenant.
 */
@Injectable()
export class WikiService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  // ---------- spaces ----------

  private toSpace(r: SpaceRow): WikiSpace {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async createSpace(input: CreateWikiSpaceRequest): Promise<WikiSpace> {
    const ctx = this.tenantContext.requireCurrent();
    const [row] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.wikiSpaces)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          description: input.description ?? null,
          createdBy: ctx.userId,
        })
        .returning(),
    );
    await this.auditRec("wiki.space_created", row!.id, { name: input.name });
    return this.toSpace(row!);
  }

  async listSpaces(): Promise<WikiSpace[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.wikiSpaces)
        .where(isNull(schema.wikiSpaces.deletedAt))
        .orderBy(asc(schema.wikiSpaces.name)),
    );
    return rows.map((r) => this.toSpace(r));
  }

  private async getSpaceRowOrFail(id: string): Promise<SpaceRow> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.wikiSpaces)
        .where(
          and(eq(schema.wikiSpaces.id, id), isNull(schema.wikiSpaces.deletedAt)),
        )
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException("Wiki space not found.");
    return rows[0];
  }

  async getSpace(id: string): Promise<WikiSpace> {
    return this.toSpace(await this.getSpaceRowOrFail(id));
  }

  async updateSpace(id: string, input: UpdateWikiSpaceRequest): Promise<WikiSpace> {
    await this.getSpaceRowOrFail(id);
    const [row] = await this.tenantDb.run((tx) =>
      tx
        .update(schema.wikiSpaces)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(schema.wikiSpaces.id, id))
        .returning(),
    );
    await this.auditRec("wiki.space_updated", id, {});
    return this.toSpace(row!);
  }

  async deleteSpace(id: string): Promise<void> {
    await this.getSpaceRowOrFail(id);
    await this.tenantDb.run(async (tx) => {
      await tx
        .update(schema.wikiPages)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.wikiPages.spaceId, id),
            isNull(schema.wikiPages.deletedAt),
          ),
        );
      await tx
        .update(schema.wikiSpaces)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.wikiSpaces.id, id));
    });
    await this.auditRec("wiki.space_deleted", id, {});
  }

  // ---------- pages ----------

  private toPage(r: PageRow): WikiPage {
    return {
      ...this.toSummary(r),
      content: r.content as ProseMirrorDoc,
      createdBy: r.createdBy,
      updatedBy: r.updatedBy,
      createdAt: r.createdAt.toISOString(),
    };
  }
  private toSummary(r: PageRow): WikiPageSummary {
    return {
      id: r.id,
      spaceId: r.spaceId,
      parentId: r.parentId,
      title: r.title,
      depth: r.path.split(".").length,
      currentVersionNo: r.currentVersionNo,
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async createPage(input: CreateWikiPageRequest): Promise<WikiPage> {
    const ctx = this.tenantContext.requireCurrent();
    await this.getSpaceRowOrFail(input.spaceId); // 404 unknown / cross-tenant
    const id = randomUUID();
    const content = input.content ?? EMPTY_DOC;
    const contentText = extractText(content);

    await this.tenantDb.run(async (tx) => {
      let parentPath: string | null = null;
      if (input.parentId) {
        const parent = (
          await tx
            .select({
              path: schema.wikiPages.path,
              spaceId: schema.wikiPages.spaceId,
            })
            .from(schema.wikiPages)
            .where(
              and(
                eq(schema.wikiPages.id, input.parentId),
                isNull(schema.wikiPages.deletedAt),
              ),
            )
            .limit(1)
        )[0];
        if (!parent || parent.spaceId !== input.spaceId)
          throw new BadRequestException("Parent page not found in this space.");
        parentPath = parent.path;
      }
      const path = parentPath ? `${parentPath}.${label(id)}` : label(id);
      await tx.insert(schema.wikiPages).values({
        id,
        tenantId: ctx.tenantId,
        spaceId: input.spaceId,
        parentId: input.parentId ?? null,
        title: input.title,
        content,
        contentText,
        path: sql`${path}::ltree`,
        currentVersionNo: 1,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
      await tx.insert(schema.wikiPageVersions).values({
        tenantId: ctx.tenantId,
        pageId: id,
        versionNo: 1,
        title: input.title,
        content,
        contentText,
        createdBy: ctx.userId,
      });
    });
    await this.auditRec("wiki.page_created", id, { title: input.title });
    return this.toPage(await this.getPageRowOrFail(id));
  }

  /** The tree for a space — path-ordered summaries (root → leaves). */
  async listPages(spaceId: string): Promise<WikiPageSummary[]> {
    await this.getSpaceRowOrFail(spaceId);
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.wikiPages)
        .where(
          and(
            eq(schema.wikiPages.spaceId, spaceId),
            isNull(schema.wikiPages.deletedAt),
          ),
        )
        .orderBy(asc(schema.wikiPages.path)),
    );
    return rows.map((r) => this.toSummary(r));
  }

  private async getPageRowOrFail(id: string): Promise<PageRow> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.wikiPages)
        .where(
          and(eq(schema.wikiPages.id, id), isNull(schema.wikiPages.deletedAt)),
        )
        .limit(1),
    );
    if (!rows[0]) throw new NotFoundException("Wiki page not found.");
    return rows[0];
  }

  async getPage(id: string): Promise<WikiPage> {
    return this.toPage(await this.getPageRowOrFail(id));
  }

  async updatePage(id: string, input: UpdateWikiPageRequest): Promise<WikiPage> {
    const ctx = this.tenantContext.requireCurrent();
    const existing = await this.getPageRowOrFail(id);
    const title = input.title ?? existing.title;
    const content = (input.content ?? existing.content) as ProseMirrorDoc;
    const contentText = extractText(content);
    const nextNo = existing.currentVersionNo + 1;

    await this.tenantDb.run(async (tx) => {
      await tx.insert(schema.wikiPageVersions).values({
        tenantId: ctx.tenantId,
        pageId: id,
        versionNo: nextNo,
        title,
        content,
        contentText,
        createdBy: ctx.userId,
      });
      await tx
        .update(schema.wikiPages)
        .set({
          title,
          content,
          contentText,
          currentVersionNo: nextNo,
          updatedBy: ctx.userId,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.wikiPages.id, id));
    });
    await this.auditRec("wiki.page_updated", id, { versionNo: nextNo });
    return this.toPage(await this.getPageRowOrFail(id));
  }

  /** Re-parent a page (+ its subtree) within the same space (P3.3-style repath). */
  async movePage(id: string, input: MoveWikiPageRequest): Promise<WikiPage> {
    const self = await this.getPageRowOrFail(id);
    await this.tenantDb.run(async (tx) => {
      let newPrefix = label(id);
      if (input.parentId) {
        if (input.parentId === id)
          throw new BadRequestException("A page can't be its own parent.");
        const parent = (
          await tx
            .select({
              path: schema.wikiPages.path,
              spaceId: schema.wikiPages.spaceId,
            })
            .from(schema.wikiPages)
            .where(
              and(
                eq(schema.wikiPages.id, input.parentId),
                isNull(schema.wikiPages.deletedAt),
              ),
            )
            .limit(1)
        )[0];
        if (!parent || parent.spaceId !== self.spaceId)
          throw new BadRequestException("Target parent not found in this space.");
        const desc = (
          await tx.execute(
            sql`SELECT ${parent.path}::ltree <@ ${self.path}::ltree AS is_desc`,
          )
        )[0] as { is_desc: boolean };
        if (desc.is_desc)
          throw new BadRequestException("Can't move a page under its own subtree.");
        newPrefix = `${parent.path}.${label(id)}`;
      }
      await tx.execute(
        sql`UPDATE wiki_pages
            SET path = CASE
                  WHEN path = ${self.path}::ltree THEN ${newPrefix}::ltree
                  ELSE ${newPrefix}::ltree || subpath(path, nlevel(${self.path}::ltree))
                END,
                updated_at = now()
            WHERE path <@ ${self.path}::ltree`,
      );
      await tx
        .update(schema.wikiPages)
        .set({ parentId: input.parentId ?? null })
        .where(eq(schema.wikiPages.id, id));
    });
    await this.auditRec("wiki.page_moved", id, { parentId: input.parentId });
    return this.toPage(await this.getPageRowOrFail(id));
  }

  async deletePage(id: string): Promise<void> {
    const self = await this.getPageRowOrFail(id);
    await this.tenantDb.run((tx) =>
      tx.execute(
        sql`UPDATE wiki_pages SET deleted_at = now(), updated_at = now()
            WHERE path <@ ${self.path}::ltree AND deleted_at IS NULL`,
      ),
    );
    await this.auditRec("wiki.page_deleted", id, {});
  }

  // ---------- versions ----------

  async listVersions(pageId: string): Promise<WikiPageVersion[]> {
    const page = await this.getPageRowOrFail(pageId);
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.wikiPageVersions)
        .where(eq(schema.wikiPageVersions.pageId, pageId))
        .orderBy(desc(schema.wikiPageVersions.versionNo)),
    );
    return rows.map((r) => ({
      versionNo: r.versionNo,
      title: r.title,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      isCurrent: r.versionNo === page.currentVersionNo,
    }));
  }

  /** Restore an old version: capture it as a NEW version + make it current. */
  async restoreVersion(pageId: string, versionNo: number): Promise<WikiPage> {
    const ctx = this.tenantContext.requireCurrent();
    const page = await this.getPageRowOrFail(pageId);
    const version = (
      await this.tenantDb.run((tx) =>
        tx
          .select()
          .from(schema.wikiPageVersions)
          .where(
            and(
              eq(schema.wikiPageVersions.pageId, pageId),
              eq(schema.wikiPageVersions.versionNo, versionNo),
            ),
          )
          .limit(1),
      )
    )[0];
    if (!version) throw new NotFoundException("Version not found.");
    const nextNo = page.currentVersionNo + 1;

    await this.tenantDb.run(async (tx) => {
      await tx.insert(schema.wikiPageVersions).values({
        tenantId: ctx.tenantId,
        pageId,
        versionNo: nextNo,
        title: version.title,
        content: version.content,
        contentText: version.contentText,
        createdBy: ctx.userId,
      });
      await tx
        .update(schema.wikiPages)
        .set({
          title: version.title,
          content: version.content,
          contentText: version.contentText,
          currentVersionNo: nextNo,
          updatedBy: ctx.userId,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.wikiPages.id, pageId));
    });
    await this.auditRec("wiki.page_restored", pageId, {
      restoredFrom: versionNo,
      versionNo: nextNo,
    });
    return this.toPage(await this.getPageRowOrFail(pageId));
  }

  // ---------- comments (P3.10b) ----------

  private toComment(r: CommentRow): WikiComment {
    return {
      id: r.id,
      pageId: r.pageId,
      parentId: r.parentId,
      authorId: r.authorId,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  /** Comments on a page, flat + oldest-first (the client threads by parentId). */
  async listComments(pageId: string): Promise<WikiComment[]> {
    await this.getPageRowOrFail(pageId);
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.wikiComments)
        .where(
          and(
            eq(schema.wikiComments.pageId, pageId),
            isNull(schema.wikiComments.deletedAt),
          ),
        )
        .orderBy(asc(schema.wikiComments.createdAt)),
    );
    return rows.map((r) => this.toComment(r));
  }

  async createComment(
    pageId: string,
    input: CreateWikiCommentRequest,
  ): Promise<WikiComment> {
    const ctx = this.tenantContext.requireCurrent();
    await this.getPageRowOrFail(pageId);
    if (input.parentId) {
      const parentId = input.parentId;
      const parent = (
        await this.tenantDb.run((tx) =>
          tx
            .select({ pageId: schema.wikiComments.pageId })
            .from(schema.wikiComments)
            .where(
              and(
                eq(schema.wikiComments.id, parentId),
                isNull(schema.wikiComments.deletedAt),
              ),
            )
            .limit(1),
        )
      )[0];
      if (!parent || parent.pageId !== pageId)
        throw new BadRequestException("Parent comment not found on this page.");
    }
    const [row] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.wikiComments)
        .values({
          tenantId: ctx.tenantId,
          pageId,
          parentId: input.parentId ?? null,
          authorId: ctx.userId,
          body: input.body,
        })
        .returning(),
    );
    await this.auditRec("wiki.comment_created", row!.id, { pageId });
    return this.toComment(row!);
  }

  /** Delete a comment: the author, or a `wiki:manage` holder, may remove it. */
  async deleteComment(commentId: string): Promise<void> {
    const ctx = this.tenantContext.requireCurrent();
    const row = (
      await this.tenantDb.run((tx) =>
        tx
          .select()
          .from(schema.wikiComments)
          .where(
            and(
              eq(schema.wikiComments.id, commentId),
              isNull(schema.wikiComments.deletedAt),
            ),
          )
          .limit(1),
      )
    )[0];
    if (!row) throw new NotFoundException("Comment not found.");
    if (row.authorId !== ctx.userId) {
      const canManage = await this.rbac.hasPermission(
        ctx.tenantId,
        ctx.userId,
        "wiki:manage",
      );
      if (!canManage)
        throw new ForbiddenException("Only the author or a manager can delete this.");
    }
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.wikiComments)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.wikiComments.id, commentId)),
    );
    await this.auditRec("wiki.comment_deleted", commentId, { pageId: row.pageId });
  }

  // ---------- internal ----------

  private async auditRec(
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const ctx = this.tenantContext.requireCurrent();
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action,
      resourceType: "wiki",
      resourceId,
      outcome: "success",
      metadata,
    });
  }
}
