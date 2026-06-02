import { randomUUID } from "crypto";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import type {
  CreateFolderGrantRequest,
  CreateFolderRequest,
  Folder,
  FolderGrant,
  MoveFolderRequest,
  RenameFolderRequest,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { AuditService } from "../audit/audit.service";
import { FolderAccessService } from "./folder-access.service";

type Actor = {
  userId: string;
  tenantId: string;
  ip?: string | null;
  userAgent?: string | null;
};
type FolderRow = typeof schema.folders.$inferSelect;
type GrantRow = typeof schema.folderGrants.$inferSelect;

/** UUID → ltree-safe label (hyphens aren't valid in ltree labels). */
function label(id: string): string {
  return id.replace(/-/g, "");
}

/**
 * Folder hierarchy (P3.3 / ADR-0047). The tree is an `ltree` materialised path
 * of id-labels (root → self), so a rename touches only `name` and a move repaths
 * the whole subtree in one statement. All reads/writes run in the request's
 * tenant tx; RLS confines them (a cross-tenant id is a clean 404). Per-folder
 * permission inheritance is the P3.3b follow-on.
 */
@Injectable()
export class FoldersService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly audit: AuditService,
    private readonly access: FolderAccessService,
  ) {}

  async create(input: CreateFolderRequest, actor: Actor): Promise<Folder> {
    // Creating under a restricted parent needs write access to it (P3.3b).
    if (input.parentId) await this.access.assertCanWrite(input.parentId);
    const id = randomUUID();
    await this.tenantDb.run(async (tx) => {
      let parentPath: string | null = null;
      if (input.parentId) {
        const parent = (
          await tx
            .select({ path: schema.folders.path })
            .from(schema.folders)
            .where(
              and(
                eq(schema.folders.id, input.parentId),
                isNull(schema.folders.deletedAt),
              ),
            )
            .limit(1)
        )[0];
        if (!parent) throw new BadRequestException("Parent folder not found");
        parentPath = parent.path;
      }
      const path = parentPath ? `${parentPath}.${label(id)}` : label(id);
      await tx.insert(schema.folders).values({
        id,
        tenantId: actor.tenantId,
        parentId: input.parentId ?? null,
        name: input.name,
        path: sql`${path}::ltree`,
        createdBy: actor.userId,
      });
    });
    await this.access.invalidateTenant(actor.tenantId); // creator gains a path
    await this.record(actor, "folder.created", id, { name: input.name });
    return (await this.getById(id))!;
  }

  async getById(id: string): Promise<Folder | null> {
    const row = await this.tenantDb.run(async (tx) =>
      (
        await tx
          .select()
          .from(schema.folders)
          .where(
            and(eq(schema.folders.id, id), isNull(schema.folders.deletedAt)),
          )
          .limit(1)
      ).at(0),
    );
    return row ? toContract(row) : null;
  }

  async getByIdOrFail(id: string): Promise<Folder> {
    const f = await this.getById(id);
    if (!f) throw new NotFoundException("Folder not found");
    return f;
  }

  /** Immediate children of `parentId` (null → root folders). */
  async listChildren(parentId: string | null): Promise<Folder[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.folders)
        .where(
          and(
            isNull(schema.folders.deletedAt),
            parentId
              ? eq(schema.folders.parentId, parentId)
              : isNull(schema.folders.parentId),
          ),
        )
        .orderBy(asc(schema.folders.name)),
    );
    return rows.map(toContract);
  }

  /**
   * The tenant tree the caller can read (flat, path-ordered). Restricted
   * subtrees without an inherited grant are filtered out (P3.3b).
   */
  async tree(): Promise<Folder[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.folders)
        .where(isNull(schema.folders.deletedAt))
        .orderBy(asc(schema.folders.path)),
    );
    const ctx = await this.access.resolveContext();
    return rows
      .filter((r) => this.access.canReadPath(r.path, ctx))
      .map(toContract);
  }

  async rename(
    id: string,
    input: RenameFolderRequest,
    actor: Actor,
  ): Promise<Folder> {
    await this.access.assertCanWrite(id); // 404 if gone, 403 if no write
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.folders)
        .set({ name: input.name, updatedAt: sql`now()` })
        .where(eq(schema.folders.id, id)),
    );
    await this.record(actor, "folder.renamed", id, { name: input.name });
    return (await this.getById(id))!;
  }

  async move(
    id: string,
    input: MoveFolderRequest,
    actor: Actor,
  ): Promise<Folder> {
    await this.access.assertCanWrite(id); // write on the folder being moved
    if (input.parentId) await this.access.assertCanWrite(input.parentId); // + target
    await this.tenantDb.run(async (tx) => {
      const self = (
        await tx
          .select({ path: schema.folders.path })
          .from(schema.folders)
          .where(
            and(eq(schema.folders.id, id), isNull(schema.folders.deletedAt)),
          )
          .limit(1)
      )[0];
      if (!self) throw new NotFoundException("Folder not found");

      let newPrefix = label(id);
      if (input.parentId) {
        if (input.parentId === id) {
          throw new BadRequestException("A folder cannot be its own parent");
        }
        const parent = (
          await tx
            .select({ path: schema.folders.path })
            .from(schema.folders)
            .where(
              and(
                eq(schema.folders.id, input.parentId),
                isNull(schema.folders.deletedAt),
              ),
            )
            .limit(1)
        )[0];
        if (!parent) throw new BadRequestException("Parent folder not found");
        // Reject moving into own subtree (would create a cycle).
        const descendant = (
          await tx.execute(
            sql`SELECT ${parent.path}::ltree <@ ${self.path}::ltree AS is_desc`,
          )
        ).at(0) as { is_desc: boolean } | undefined;
        if (descendant?.is_desc) {
          throw new BadRequestException(
            "Cannot move a folder into itself or a descendant",
          );
        }
        newPrefix = `${parent.path}.${label(id)}`;
      }

      // Repath the whole subtree: replace the `self.path` prefix with
      // `newPrefix`. The CASE handles the moved folder itself — `subpath` errors
      // when its offset equals nlevel (no suffix), which is exactly the self row.
      await tx.execute(
        sql`UPDATE folders
            SET path = CASE
                  WHEN path = ${self.path}::ltree THEN ${newPrefix}::ltree
                  ELSE ${newPrefix}::ltree || subpath(path, nlevel(${self.path}::ltree))
                END,
                updated_at = now()
            WHERE path <@ ${self.path}::ltree`,
      );
      await tx
        .update(schema.folders)
        .set({ parentId: input.parentId ?? null })
        .where(eq(schema.folders.id, id));
    });
    await this.access.invalidateTenant(actor.tenantId); // paths changed
    await this.record(actor, "folder.moved", id, {
      parentId: input.parentId ?? null,
    });
    return (await this.getById(id))!;
  }

  /** Soft-delete the folder + its whole subtree; unfile any documents in it. */
  async remove(id: string, actor: Actor): Promise<void> {
    await this.access.assertCanWrite(id);
    await this.tenantDb.run(async (tx) => {
      const self = (
        await tx
          .select({ path: schema.folders.path })
          .from(schema.folders)
          .where(
            and(eq(schema.folders.id, id), isNull(schema.folders.deletedAt)),
          )
          .limit(1)
      )[0];
      if (!self) throw new NotFoundException("Folder not found");

      // Unfile documents anywhere in the subtree (keep the docs, drop the link).
      await tx.execute(
        sql`UPDATE documents SET folder_id = NULL, updated_at = now()
            WHERE folder_id IN (
              SELECT id FROM folders WHERE path <@ ${self.path}::ltree
            )`,
      );
      // Soft-delete the subtree.
      await tx.execute(
        sql`UPDATE folders SET deleted_at = now(), updated_at = now()
            WHERE path <@ ${self.path}::ltree AND deleted_at IS NULL`,
      );
    });
    await this.access.invalidateTenant(actor.tenantId); // paths removed
    await this.record(actor, "folder.deleted", id);
  }

  // ---------- restriction + grants (P3.3b / ADR-0048) ----------

  async setRestricted(
    id: string,
    restricted: boolean,
    actor: Actor,
  ): Promise<Folder> {
    await this.getByIdOrFail(id); // 404 if gone (endpoint is folder:manage-gated)
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.folders)
        .set({ restricted, updatedAt: sql`now()` })
        .where(eq(schema.folders.id, id)),
    );
    await this.access.invalidateTenant(actor.tenantId);
    await this.record(actor, "folder.restricted", id, { restricted });
    return (await this.getById(id))!;
  }

  /** Set/clear a folder's retention policy (P3.5; inherited down the subtree). */
  async setRetention(
    id: string,
    retentionDays: number | null,
    actor: Actor,
  ): Promise<Folder> {
    await this.access.assertCanWrite(id); // 404 if gone, 403 if no write
    await this.tenantDb.run((tx) =>
      tx
        .update(schema.folders)
        .set({ retentionDays, updatedAt: sql`now()` })
        .where(eq(schema.folders.id, id)),
    );
    await this.record(actor, "folder.retention_set", id, { retentionDays });
    return (await this.getById(id))!;
  }

  async listGrants(folderId: string): Promise<FolderGrant[]> {
    await this.getByIdOrFail(folderId);
    return this.tenantDb.run(async (tx) => {
      const rows = (await tx
        .select()
        .from(schema.folderGrants)
        .where(eq(schema.folderGrants.folderId, folderId))
        .orderBy(desc(schema.folderGrants.createdAt))) as GrantRow[];
      return Promise.all(rows.map((r) => this.grantToContract(tx, r)));
    });
  }

  async addGrant(
    folderId: string,
    input: CreateFolderGrantRequest,
    actor: Actor,
  ): Promise<FolderGrant> {
    await this.getByIdOrFail(folderId);
    // Validate the subject exists in the tenant (RLS-scoped).
    await this.assertSubjectExists(input.subjectType, input.subjectId);
    const grant = await this.tenantDb.run(async (tx) => {
      const [row] = (await tx
        .insert(schema.folderGrants)
        .values({
          tenantId: actor.tenantId,
          folderId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          access: input.access,
          createdBy: actor.userId,
        })
        .onConflictDoUpdate({
          target: [
            schema.folderGrants.folderId,
            schema.folderGrants.subjectType,
            schema.folderGrants.subjectId,
          ],
          set: { access: input.access },
        })
        .returning()) as GrantRow[];
      return this.grantToContract(tx, row!);
    });
    await this.access.invalidateTenant(actor.tenantId);
    await this.record(actor, "folder.grant_added", folderId, {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      access: input.access,
    });
    return grant;
  }

  async removeGrant(
    folderId: string,
    grantId: string,
    actor: Actor,
  ): Promise<void> {
    await this.getByIdOrFail(folderId);
    const deleted = await this.tenantDb.run((tx) =>
      tx
        .delete(schema.folderGrants)
        .where(
          and(
            eq(schema.folderGrants.id, grantId),
            eq(schema.folderGrants.folderId, folderId),
          ),
        )
        .returning({ id: schema.folderGrants.id }),
    );
    if (deleted.length === 0) throw new NotFoundException("Grant not found");
    await this.access.invalidateTenant(actor.tenantId);
    await this.record(actor, "folder.grant_removed", folderId, { grantId });
  }

  private async assertSubjectExists(
    subjectType: string,
    subjectId: string,
  ): Promise<void> {
    const exists = await this.tenantDb.run(async (tx) => {
      if (subjectType === "user") {
        return (
          await tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(
              and(
                eq(schema.users.id, subjectId),
                isNull(schema.users.deletedAt),
              ),
            )
            .limit(1)
        ).length;
      }
      return (
        await tx
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(eq(schema.roles.id, subjectId))
          .limit(1)
      ).length;
    });
    if (!exists) {
      throw new BadRequestException(`${subjectType} not found in this tenant`);
    }
  }

  private async grantToContract(
    tx: Parameters<Parameters<TenantDatabaseService["run"]>[0]>[0],
    row: GrantRow,
  ): Promise<FolderGrant> {
    let subjectName: string | null = null;
    if (row.subjectType === "user") {
      subjectName =
        (
          await tx
            .select({ name: schema.users.name })
            .from(schema.users)
            .where(eq(schema.users.id, row.subjectId))
            .limit(1)
        )[0]?.name ?? null;
    } else {
      subjectName =
        (
          await tx
            .select({ name: schema.roles.name })
            .from(schema.roles)
            .where(eq(schema.roles.id, row.subjectId))
            .limit(1)
        )[0]?.name ?? null;
    }
    return {
      id: row.id,
      folderId: row.folderId,
      subjectType: row.subjectType as FolderGrant["subjectType"],
      subjectId: row.subjectId,
      subjectName,
      access: row.access as FolderGrant["access"],
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async record(
    actor: Actor,
    action: string,
    resourceId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: "user",
      action,
      resourceType: "folder",
      resourceId,
      outcome: "success",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      ...(metadata ? { metadata } : {}),
    });
  }
}

function toContract(row: FolderRow): Folder {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    depth: row.path.split(".").length,
    restricted: row.restricted,
    retentionDays: row.retentionDays,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
