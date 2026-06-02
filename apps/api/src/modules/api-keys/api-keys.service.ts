import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { schema } from "@cmc/db";
import {
  CreateApiKeySchema,
  type ApiKey,
  type ApiKeyCreatedResponse,
  type Permission,
} from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { TenantContextService } from "../../common/tenant-context/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "../rbac/rbac.service";
import { generateApiKey, hashApiKey } from "./api-key.crypto";

type ApiKeyRow = typeof schema.apiKeys.$inferSelect;

/**
 * API key management (P3.9a / ADR-0054). Mints keys whose scopes are a subset
 * of the creating user's permissions (no privilege escalation), stores only the
 * SHA-256 hash, and returns the plaintext secret once. Auth-by-key happens in
 * `TenantContextMiddleware` (an indexed hash lookup); this service is the
 * user-facing CRUD. TenantDatabaseService + AuditService are @Global.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly tenantDb: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  private toContract(row: ApiKeyRow): ApiKey {
    return {
      id: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      scopes: (row.scopes ?? []) as string[],
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async create(raw: unknown): Promise<ApiKeyCreatedResponse> {
    const ctx = this.tenantContext.requireCurrent();
    let input;
    try {
      input = CreateApiKeySchema.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          `Invalid API key — ${err.issues.map((i) => i.message).join("; ")}`,
        );
      }
      throw err;
    }

    // No privilege escalation: a key can't grant a permission the creator
    // doesn't hold (enforced even for tenant_admin, who holds everything).
    const held = await this.rbac.resolvePermissions(ctx.tenantId, ctx.userId);
    const overreach = input.scopes.filter(
      (s) => !held.has(s as Permission),
    );
    if (overreach.length > 0) {
      throw new BadRequestException(
        `Cannot grant scopes you don't hold: ${overreach.join(", ")}`,
      );
    }

    const { secret, displayPrefix } = generateApiKey();
    const expiresAt =
      input.expiresInDays != null
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null;

    const [row] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.apiKeys)
        .values({
          tenantId: ctx.tenantId,
          name: input.name,
          keyPrefix: displayPrefix,
          keyHash: hashApiKey(secret),
          scopes: input.scopes,
          createdBy: ctx.userId,
          expiresAt,
        })
        .returning(),
    );
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "api_key.created",
      resourceType: "api_key",
      resourceId: row!.id,
      outcome: "success",
      metadata: { name: input.name, scopes: input.scopes },
    });
    return { apiKey: this.toContract(row!), secret };
  }

  async list(): Promise<ApiKey[]> {
    const rows = await this.tenantDb.run((tx) =>
      tx
        .select()
        .from(schema.apiKeys)
        .orderBy(desc(schema.apiKeys.createdAt)),
    );
    return rows.map((r) => this.toContract(r));
  }

  async revoke(id: string): Promise<void> {
    const ctx = this.tenantContext.requireCurrent();
    const rows = await this.tenantDb.run((tx) =>
      tx
        .update(schema.apiKeys)
        .set({ revokedAt: sql`now()` })
        .where(
          and(eq(schema.apiKeys.id, id), isNull(schema.apiKeys.revokedAt)),
        )
        .returning({ id: schema.apiKeys.id }),
    );
    if (rows.length === 0) {
      // Either unknown (cross-tenant → RLS hides it) or already revoked.
      const exists = await this.tenantDb.run((tx) =>
        tx
          .select({ id: schema.apiKeys.id })
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.id, id))
          .limit(1),
      );
      if (exists.length === 0) throw new NotFoundException("API key not found.");
      return; // already revoked → idempotent
    }
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorType: "user",
      action: "api_key.revoked",
      resourceType: "api_key",
      resourceId: id,
      outcome: "success",
    });
  }
}
