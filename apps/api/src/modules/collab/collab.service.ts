import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { and, eq, isNull } from "drizzle-orm";
import type { Redis } from "ioredis";
import { schema } from "@cmc/db";
import type { CollabTicketResponse } from "@cmc/contracts";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { RbacService } from "../rbac/rbac.service";
import { REDIS } from "../redis/redis.tokens";
import type { AppConfig } from "../../config/configuration";

/** The collaborative-editing field name shared with the web TipTap binding. */
const COLLAB_FIELD = "default";
/** Redis key prefix for single-use WS connection tickets. */
const TICKET_PREFIX = "collab:ticket:";

type JwtClaims = { sub: string; tid: string; sid?: string };
export type CollabContext = { userId: string; tenantId: string; pageId: string };
/** What a minted ticket stores in Redis (bound to one doc + collaborator). */
type TicketPayload = {
  userId: string;
  tenantId: string;
  pageId: string;
  docName: string;
};

// A minimal Y.Doc shape so we don't import `yjs` types at module load (the lib
// is dynamic-imported to stay out of the jest runtime).
type YDoc = unknown;

function extractText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) {
    return n.content.map(extractText).join(n.type === "paragraph" ? "" : " ");
  }
  return "";
}

/**
 * Realtime-collaboration persistence + authorization (P4.1 / ADR-0060). The
 * Hocuspocus server's hooks call into this:
 *  - `authorize` (onAuthenticate) — verify the JWT, confirm the wiki page is in
 *    the caller's tenant, and require `wiki:write`.
 *  - `loadDocument` (onLoadDocument) — return the stored Y.Doc, or seed a fresh
 *    one from the page's current ProseMirror content (first collaborator).
 *  - `storeDocument` (onStoreDocument, debounced) — persist the Y.Doc bytes AND
 *    snapshot them back to `wiki_pages.content` + derived plaintext so search /
 *    non-collab reads stay current.
 *
 * Decoupled from the WS server so it's unit/e2e-testable without booting
 * Hocuspocus. `yjs` + the TipTap transformer are dynamic-imported (heavy/ESM).
 */
@Injectable()
export class CollabService {
  private readonly logger = new Logger(CollabService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly rbac: RbacService,
    private readonly tenantDb: TenantDatabaseService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** `wiki.<pageId>` → pageId, else null (only wiki docs are collaborative today). */
  parsePageId(docName: string): string | null {
    const m = /^wiki\.([0-9a-f-]{36})$/.exec(docName);
    return m ? m[1]! : null;
  }

  /**
   * Verify a collaborator may open `docName`. Returns the context, or null to
   * reject the connection (Hocuspocus closes it).
   */
  async authorize(
    token: string,
    docName: string,
  ): Promise<CollabContext | null> {
    const pageId = this.parsePageId(docName);
    if (!pageId) return null;
    let claims: JwtClaims;
    try {
      claims = await this.jwt.verifyAsync<JwtClaims>(token, {
        algorithms: ["HS256"],
        issuer: this.config.get("JWT_ISSUER", { infer: true }),
      });
    } catch {
      return null;
    }
    if (!claims.sub || !claims.tid) return null;

    if (!(await this.pageInTenant(claims.tid, pageId))) return null;
    const canWrite = await this.rbac.hasPermission(
      claims.tid,
      claims.sub,
      "wiki:write",
    );
    if (!canWrite) return null;
    return { userId: claims.sub, tenantId: claims.tid, pageId };
  }

  /** Is `pageId` a live (not soft-deleted) wiki page in this tenant? */
  private async pageInTenant(tenantId: string, pageId: string): Promise<boolean> {
    return this.tenantDb.runForTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ id: schema.wikiPages.id })
        .from(schema.wikiPages)
        .where(
          and(eq(schema.wikiPages.id, pageId), isNull(schema.wikiPages.deletedAt)),
        );
      return !!row;
    });
  }

  /**
   * Resolve a WS connection at the Hocuspocus handshake. The browser presents a
   * single-use **ticket** (BFF posture — no raw JWT); tests / the live smoke may
   * present a JWT directly. Try the ticket first (consume it), then fall back to
   * JWT verification.
   */
  async authorizeConnection(
    token: string,
    docName: string,
  ): Promise<CollabContext | null> {
    const viaTicket = await this.consumeTicket(token, docName);
    if (viaTicket) return viaTicket;
    return this.authorize(token, docName);
  }

  /**
   * Mint a single-use, short-lived ticket the browser hands to Hocuspocus.
   * `wiki:write` on the page is required (404 if the page isn't in the tenant,
   * 403 without the permission). The ticket is bound to this doc + collaborator
   * and stored in Redis with a TTL; `consumeTicket` GETDELs it at handshake.
   */
  async issueTicket(
    user: { userId: string; tenantId: string; email: string },
    pageId: string,
  ): Promise<CollabTicketResponse> {
    const docName = `wiki.${pageId}`;
    if (!(await this.pageInTenant(user.tenantId, pageId))) {
      throw new NotFoundException("Wiki page not found");
    }
    const canWrite = await this.rbac.hasPermission(
      user.tenantId,
      user.userId,
      "wiki:write",
    );
    if (!canWrite) throw new ForbiddenException("wiki:write required");

    const ticket = randomBytes(32).toString("base64url");
    const payload: TicketPayload = {
      userId: user.userId,
      tenantId: user.tenantId,
      pageId,
      docName,
    };
    await this.redis.set(
      `${TICKET_PREFIX}${ticket}`,
      JSON.stringify(payload),
      "EX",
      this.config.get("HOCUSPOCUS_TICKET_TTL_SECONDS", { infer: true }),
    );

    return {
      ticket,
      docName,
      wsUrl: this.config.get("HOCUSPOCUS_PUBLIC_URL", { infer: true }),
      field: COLLAB_FIELD,
      enabled: this.config.get("HOCUSPOCUS_ENABLED", { infer: true }),
      user: { id: user.userId, name: user.email.split("@")[0] || user.email },
    };
  }

  /** GETDEL a ticket (single-use) and return its context if it matches `docName`. */
  async consumeTicket(
    token: string,
    docName: string,
  ): Promise<CollabContext | null> {
    let raw: string | null;
    try {
      raw = await this.redis.getdel(`${TICKET_PREFIX}${token}`);
    } catch {
      // GETDEL needs Redis ≥6.2; degrade to GET+DEL if unavailable.
      raw = await this.redis.get(`${TICKET_PREFIX}${token}`);
      if (raw) await this.redis.del(`${TICKET_PREFIX}${token}`);
    }
    if (!raw) return null;
    let payload: TicketPayload;
    try {
      payload = JSON.parse(raw) as TicketPayload;
    } catch {
      return null;
    }
    if (payload.docName !== docName) return null;
    return {
      userId: payload.userId,
      tenantId: payload.tenantId,
      pageId: payload.pageId,
    };
  }

  /** Stored Y.Doc, or a fresh one seeded from the page's current content. */
  async loadDocument(docName: string, tenantId: string): Promise<YDoc> {
    const Y = await import("yjs");
    const { TiptapTransformer } = await import("@hocuspocus/transformer");
    const StarterKit = (await import("@tiptap/starter-kit")).default;

    const row = await this.tenantDb.runForTenant(tenantId, async (tx) => {
      const [r] = await tx
        .select()
        .from(schema.collabDocs)
        .where(eq(schema.collabDocs.name, docName));
      return r ?? null;
    });

    if (row) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(row.state));
      return doc;
    }

    // Seed from the page's current ProseMirror JSON (first collaborator).
    const pageId = this.parsePageId(docName);
    const content = pageId
      ? await this.tenantDb.runForTenant(tenantId, async (tx) => {
          const [p] = await tx
            .select({ content: schema.wikiPages.content })
            .from(schema.wikiPages)
            .where(eq(schema.wikiPages.id, pageId));
          return (p?.content as Record<string, unknown> | undefined) ?? null;
        })
      : null;
    return TiptapTransformer.toYdoc(
      content ?? { type: "doc", content: [] },
      COLLAB_FIELD,
      [StarterKit],
    );
  }

  /**
   * Persist the Y.Doc state and snapshot it back to the wiki page (content +
   * derived plaintext). Called debounced by Hocuspocus; also directly by tests.
   */
  async storeDocument(
    docName: string,
    tenantId: string,
    state: Uint8Array,
  ): Promise<void> {
    const Y = await import("yjs");
    const { TiptapTransformer } = await import("@hocuspocus/transformer");
    const bytes = Buffer.from(state);

    // Snapshot Y.Doc → ProseMirror JSON for the domain row + search text.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const json = TiptapTransformer.fromYdoc(doc, COLLAB_FIELD) as Record<
      string,
      unknown
    >;
    const contentText = extractText(json).replace(/\s+/g, " ").trim();
    const pageId = this.parsePageId(docName);

    await this.tenantDb.runForTenant(tenantId, async (tx) => {
      await tx
        .insert(schema.collabDocs)
        .values({ name: docName, tenantId, state: bytes })
        .onConflictDoUpdate({
          target: schema.collabDocs.name,
          set: { state: bytes, updatedAt: new Date() },
        });
      if (pageId) {
        await tx
          .update(schema.wikiPages)
          .set({ content: json, contentText, updatedAt: new Date() })
          .where(eq(schema.wikiPages.id, pageId));
      }
    });
  }
}
