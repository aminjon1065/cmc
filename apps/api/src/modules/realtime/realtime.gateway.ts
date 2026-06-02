import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost } from "@nestjs/core";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import {
  REALTIME_PATH,
  REALTIME_SUBPROTOCOL,
  RealtimeClientMessageSchema,
} from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import { RbacService } from "../rbac/rbac.service";
import {
  WsAuthError,
  WsAuthService,
  type WsPrincipal,
} from "./ws-auth.service";
import {
  RealtimeRegistryService,
  type RealtimeConnection,
} from "./realtime-registry.service";

/**
 * WebSocket gateway for the realtime plane (P2.3 / ADR-0035). Rather than a
 * Nest WS adapter (which would replace the global adapter and touch every
 * suite), it attaches a `noServer` `ws` server to the existing HTTP server's
 * `upgrade` event — self-contained, authenticated BEFORE the socket is
 * accepted, and claiming only its own path. Disabled cleanly via
 * `REALTIME_ENABLED` (no upgrade hook → the endpoint simply isn't there).
 */
@Injectable()
export class RealtimeGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private upgradeHandler:
    | ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | null = null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly auth: WsAuthService,
    private readonly rbac: RbacService,
    private readonly registry: RealtimeRegistryService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get("REALTIME_ENABLED", { infer: true })) {
      this.logger.log("Realtime gateway disabled (REALTIME_ENABLED=false)");
      return;
    }
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer() as
      | HttpServer
      | undefined;
    if (!httpServer) {
      this.logger.warn("No HTTP server available; realtime gateway not attached");
      return;
    }
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({
      noServer: true,
      // Echo `cmc-bearer` when offered (the token rides as the 2nd protocol);
      // when absent the client used the query fallback — complete with none.
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(REALTIME_SUBPROTOCOL) ? REALTIME_SUBPROTOCOL : false,
    });
    this.upgradeHandler = (req, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? "", "http://localhost").pathname;
      } catch {
        return;
      }
      if (pathname !== REALTIME_PATH) return; // not ours — leave it alone
      void this.authenticateAndUpgrade(req, socket, head);
    };
    httpServer.on("upgrade", this.upgradeHandler);
    this.logger.log(`Realtime gateway listening on WS ${REALTIME_PATH}`);
  }

  onApplicationShutdown(): void {
    if (this.httpServer && this.upgradeHandler) {
      this.httpServer.off("upgrade", this.upgradeHandler);
    }
    this.registry.closeAll();
    this.wss?.close();
    this.wss = null;
    this.upgradeHandler = null;
    this.httpServer = null;
  }

  /**
   * Authenticate BEFORE completing the handshake: a failed auth is rejected
   * with a plain `401` and the socket destroyed — the client never sees a `101`
   * (no open, no data), and nothing is registered.
   */
  private async authenticateAndUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let principal: WsPrincipal;
    try {
      principal = await this.auth.authenticate(req);
    } catch (err) {
      const reason = err instanceof WsAuthError ? err.message : "unauthorized";
      this.logger.debug(`Rejecting WS upgrade: ${reason}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Resolve the user's permissions ONCE for the life of the connection
    // (P2.3b): subscriptions are RBAC-checked synchronously against this set.
    // Fail-closed — a resolution error leaves an empty set, so RBAC-gated
    // subscriptions are denied until the client reconnects.
    let permissions: ReadonlySet<string>;
    try {
      permissions = await this.rbac.resolvePermissions(
        principal.tenantId,
        principal.userId,
      );
    } catch (err) {
      this.logger.warn(
        `perm resolve failed for ${principal.userId}; denying subscriptions: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      permissions = new Set<string>();
    }
    this.wss?.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, principal, permissions);
    });
  }

  private onConnection(
    ws: WebSocket,
    principal: WsPrincipal,
    permissions: ReadonlySet<string>,
  ): void {
    const conn = this.registry.add(ws, principal, permissions);
    this.registry.send(conn, {
      type: "welcome",
      userId: principal.userId,
      tenantId: principal.tenantId,
      subscriptions: [],
    });
    ws.on("message", (data: RawData) => this.onMessage(conn, data));
    ws.on("close", () => this.registry.remove(ws));
    ws.on("error", () => this.registry.remove(ws));
  }

  private onMessage(conn: RealtimeConnection, data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.registry.send(conn, { type: "error", message: "invalid JSON frame" });
      return;
    }
    const result = RealtimeClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.registry.send(conn, {
        type: "error",
        message: "unrecognised message",
      });
      return;
    }
    const msg = result.data;
    switch (msg.type) {
      case "subscribe": {
        const { accepted, rejected } = this.registry.subscribe(
          conn,
          msg.subjects,
        );
        this.registry.send(conn, { type: "subscribed", accepted, rejected });
        break;
      }
      case "unsubscribe": {
        this.registry.unsubscribe(conn, msg.subjects);
        this.registry.send(conn, {
          type: "unsubscribed",
          subjects: msg.subjects,
        });
        break;
      }
      case "ping": {
        this.registry.send(conn, { type: "pong" });
        break;
      }
    }
  }
}
