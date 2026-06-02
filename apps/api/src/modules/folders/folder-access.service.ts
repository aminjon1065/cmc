import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@cmc/db";
import { REDIS } from "../redis/redis.tokens";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { TenantContextService } from "../../common/tenant-context/tenant-context.service";
import { RbacService } from "../rbac/rbac.service";

/**
 * The current user's folder-access context (P3.3b / ADR-0048): the RBAC bypass +
 * fallbacks plus the ltree paths the user has been granted (or created). All
 * inheritance reduces to "is `folderPath` a descendant-or-self of one of these
 * paths" — grants inherit down the subtree.
 */
export interface FolderAccessContext {
  isAdmin: boolean; // folder:manage → bypass all restrictions
  folderRead: boolean; // tenant-wide folder:read
  folderWrite: boolean; // tenant-wide folder:write
  readPaths: string[]; // grant(read|write) ∪ created-by
  writePaths: string[]; // grant(write) ∪ created-by
  restrictedPaths: string[]; // every restricted folder path in the tenant
}

const CACHE_TTL_SEC = 60;

function descendantOrSelf(path: string, ancestor: string): boolean {
  // ltree `path <@ ancestor`: same node or under it. Labels are fixed-width hex,
  // and the `.` guard avoids "ab" matching "abc".
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

/**
 * Folder permission inheritance (P3.3b / ADR-0048). Restricted subtrees are
 * visible only to grant-holders (+ `folder:manage` admins + a folder's creator);
 * unrestricted folders fall back to tenant-wide RBAC. The per-user context is
 * cached in Redis (short TTL) and invalidated tenant-wide on any grant/restrict
 * change.
 */
@Injectable()
export class FolderAccessService {
  private readonly logger = new Logger(FolderAccessService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly tenantDb: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly rbac: RbacService,
  ) {}

  private cacheKey(tenantId: string, userId: string): string {
    return `cmc:folderacc:${tenantId}:${userId}`;
  }

  /** Drop the cached context for every user in a tenant (grant/restrict change). */
  async invalidateTenant(tenantId: string): Promise<void> {
    try {
      let cursor = "0";
      const match = `cmc:folderacc:${tenantId}:*`;
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          match,
          "COUNT",
          100,
        );
        cursor = next;
        if (keys.length) await this.redis.del(...keys);
      } while (cursor !== "0");
    } catch (err) {
      this.logger.warn(
        `folder-access cache invalidation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Resolve (cache-first) the current user's folder-access context. */
  async resolveContext(): Promise<FolderAccessContext> {
    const ctx = this.tenantContext.requireCurrent();
    const key = this.cacheKey(ctx.tenantId, ctx.userId);
    try {
      const raw = await this.redis.get(key);
      if (raw) return JSON.parse(raw) as FolderAccessContext;
    } catch {
      /* cache miss / Redis down → resolve from DB */
    }

    const [isAdmin, folderRead, folderWrite] = await Promise.all([
      this.rbac.hasPermission(ctx.tenantId, ctx.userId, "folder:manage"),
      this.rbac.hasPermission(ctx.tenantId, ctx.userId, "folder:read"),
      this.rbac.hasPermission(ctx.tenantId, ctx.userId, "folder:write"),
    ]);

    const { readPaths, writePaths, restrictedPaths } = await this.tenantDb.run(
      async (tx) => {
        const grants = (await tx.execute(sql`
          SELECT fg.access AS access, fo.path::text AS path
          FROM folder_grants fg
          JOIN folders fo ON fo.id = fg.folder_id AND fo.deleted_at IS NULL
          WHERE (fg.subject_type = 'user' AND fg.subject_id = ${ctx.userId})
             OR (fg.subject_type = 'role' AND fg.subject_id IN (
                  SELECT role_id FROM user_roles WHERE user_id = ${ctx.userId}
                ))
        `)) as unknown as Array<{ access: string; path: string }>;

        const created = (await tx
          .select({ path: schema.folders.path })
          .from(schema.folders)
          .where(
            and(
              eq(schema.folders.createdBy, ctx.userId),
              isNull(schema.folders.deletedAt),
            ),
          )) as Array<{ path: string }>;

        const restricted = (await tx
          .select({ path: schema.folders.path })
          .from(schema.folders)
          .where(
            and(
              eq(schema.folders.restricted, true),
              isNull(schema.folders.deletedAt),
            ),
          )) as Array<{ path: string }>;

        const createdPaths = created.map((r) => r.path);
        const read = new Set<string>(createdPaths);
        const write = new Set<string>(createdPaths);
        for (const g of grants) {
          read.add(g.path);
          if (g.access === "write") write.add(g.path);
        }
        return {
          readPaths: [...read],
          writePaths: [...write],
          restrictedPaths: restricted.map((r) => r.path),
        };
      },
    );

    const resolved: FolderAccessContext = {
      isAdmin,
      folderRead,
      folderWrite,
      readPaths,
      writePaths,
      restrictedPaths,
    };
    try {
      await this.redis.set(key, JSON.stringify(resolved), "EX", CACHE_TTL_SEC);
    } catch {
      /* best-effort cache */
    }
    return resolved;
  }

  effectivelyRestricted(path: string, ctx: FolderAccessContext): boolean {
    return ctx.restrictedPaths.some((r) => descendantOrSelf(path, r));
  }

  canReadPath(path: string, ctx: FolderAccessContext): boolean {
    if (ctx.isAdmin) return true;
    if (ctx.readPaths.some((p) => descendantOrSelf(path, p))) return true;
    return ctx.folderRead && !this.effectivelyRestricted(path, ctx);
  }

  canWritePath(path: string, ctx: FolderAccessContext): boolean {
    if (ctx.isAdmin) return true;
    if (ctx.writePaths.some((p) => descendantOrSelf(path, p))) return true;
    return ctx.folderWrite && !this.effectivelyRestricted(path, ctx);
  }

  // ---------- request-scoped asserts ----------

  private async folderPath(folderId: string): Promise<string | null> {
    const row = await this.tenantDb.run(async (tx) =>
      (
        await tx
          .select({ path: schema.folders.path })
          .from(schema.folders)
          .where(
            and(
              eq(schema.folders.id, folderId),
              isNull(schema.folders.deletedAt),
            ),
          )
          .limit(1)
      ).at(0),
    );
    return row?.path ?? null;
  }

  /** 404 if the folder isn't readable (hides restricted folders' existence). */
  async assertCanRead(folderId: string): Promise<void> {
    const path = await this.folderPath(folderId);
    const ctx = await this.resolveContext();
    if (!path || !this.canReadPath(path, ctx)) {
      throw new NotFoundException("Folder not found");
    }
  }

  /** 403 if the folder isn't writable (it's visible but you can't write). */
  async assertCanWrite(folderId: string): Promise<void> {
    const path = await this.folderPath(folderId);
    if (!path) throw new NotFoundException("Folder not found");
    const ctx = await this.resolveContext();
    if (!this.canWritePath(path, ctx)) {
      throw new ForbiddenException("No write access to this folder");
    }
  }

  /** Filing a document into a folder: 400 if it's gone, 403 if no write access. */
  async assertCanFileInto(folderId: string): Promise<void> {
    const path = await this.folderPath(folderId);
    if (!path) throw new BadRequestException("Folder not found");
    const ctx = await this.resolveContext();
    if (!this.canWritePath(path, ctx)) {
      throw new ForbiddenException("No write access to this folder");
    }
  }

  /** Whether a document's folder (null = unfiled) is readable by the user. */
  async canReadDocumentFolder(folderId: string | null): Promise<boolean> {
    if (!folderId) return true; // unfiled → governed by document RBAC
    const path = await this.folderPath(folderId);
    if (!path) return true; // folder gone → treat as unfiled
    return this.canReadPath(path, await this.resolveContext());
  }

  /**
   * A correlated SQL predicate for the documents list: keep unfiled docs + docs
   * whose folder is readable. `null` when the user is an admin (no filtering).
   */
  documentListCondition(ctx: FolderAccessContext) {
    if (ctx.isAdmin) return null;
    const col = schema.documents.folderId;
    const readable =
      ctx.readPaths.length > 0
        ? sql`ARRAY[${sql.join(
            ctx.readPaths.map((p) => sql`${p}::ltree`),
            sql`, `,
          )}]`
        : sql`ARRAY[]::ltree[]`;
    // folder readable = (folderRead AND no restricted ancestor) OR covered by a grant path
    return sql`(
      ${col} IS NULL OR EXISTS (
        SELECT 1 FROM folders f
        WHERE f.id = ${col} AND f.deleted_at IS NULL AND (
          (${ctx.folderRead} AND NOT EXISTS (
            SELECT 1 FROM folders r
            WHERE r.restricted AND r.deleted_at IS NULL AND f.path <@ r.path
          ))
          OR f.path <@ ANY(${readable})
        )
      )
    )`;
  }
}
