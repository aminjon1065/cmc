import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { CollabService, type CollabContext } from "./collab.service";

/**
 * Hocuspocus (Yjs) collaboration server (P4.1 / ADR-0060). A dedicated WS server
 * — separate from the P2.3 realtime gateway, which is a broadcast plane, not the
 * bidirectional y-sync protocol. Gated on `HOCUSPOCUS_ENABLED` + skipped in
 * tests; `@hocuspocus/server` is dynamic-imported so it never enters jest. Hooks
 * delegate to {@link CollabService} (auth + persistence). Tests drive
 * CollabService directly; the real WS sync is covered by a live smoke.
 */
@Injectable()
export class CollabServer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CollabServer.name);
  private readonly enabled: boolean;
  private readonly port: number;
  private readonly debounce: number;
  private server: { destroy: () => Promise<void> } | null = null;

  constructor(
    private readonly collab: CollabService,
    config: ConfigService<AppConfig, true>,
  ) {
    // The `HOCUSPOCUS_ENABLED` gate is the sole control: it defaults false, so
    // the default test suite (which never sets it) never boots this heavy WS
    // server. Unlike the other lazy seams there's no extra NODE_ENV==='test'
    // skip — that lets the collab live smoke exercise the real server under a
    // light (test-mode) app boot just by setting HOCUSPOCUS_ENABLED=true.
    this.enabled = config.get("HOCUSPOCUS_ENABLED", { infer: true });
    this.port = config.get("HOCUSPOCUS_PORT", { infer: true });
    this.debounce = config.get("HOCUSPOCUS_SNAPSHOT_DEBOUNCE_MS", {
      infer: true,
    });
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    const { Server } = await import("@hocuspocus/server");
    const Y = await import("yjs");
    const collab = this.collab;
    // Hocuspocus's config types are intricate hook-payload intersections; wire
    // via a loosely-typed object at this dynamic-import boundary (the delegated
    // CollabService is fully type-checked). `state` isn't on the store payload —
    // derive it from the document.
    const config: Record<string, unknown> = {
      port: this.port,
      // Persist debounced; a burst of edits coalesces into one snapshot.
      debounce: this.debounce,
      onAuthenticate: async (data: {
        token: string;
        documentName: string;
      }): Promise<CollabContext> => {
        const ctx = await collab.authorizeConnection(
          data.token,
          data.documentName,
        );
        if (!ctx) throw new Error("Unauthorized");
        return ctx;
      },
      onLoadDocument: async (data: {
        documentName: string;
        context: CollabContext;
      }) => collab.loadDocument(data.documentName, data.context.tenantId),
      onStoreDocument: async (data: {
        documentName: string;
        document: import("yjs").Doc;
        context: CollabContext;
      }): Promise<void> => {
        const state = Y.encodeStateAsUpdate(data.document);
        await collab.storeDocument(
          data.documentName,
          data.context.tenantId,
          state,
        );
      },
    };
    (Server.configure as (c: Record<string, unknown>) => unknown)(config);
    await (Server as unknown as { listen: (p?: number) => Promise<unknown> }).listen(
      this.port,
    );
    this.server = Server as unknown as { destroy: () => Promise<void> };
    this.logger.log(`Hocuspocus collaboration server listening on :${this.port}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.server) {
      try {
        await this.server.destroy();
      } catch {
        /* already torn down */
      }
    }
  }
}
