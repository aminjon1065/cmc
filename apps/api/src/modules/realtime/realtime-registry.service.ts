import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WebSocket } from "ws";
import type { RealtimeServerMessage } from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import type { WsPrincipal } from "./ws-auth.service";
import { isSubjectWithinTenant, subjectMatches } from "./subject-match";
import { requiredPermissionForSubject } from "./subject-permission";

/** One live, authenticated realtime connection and its subscriptions. */
export type RealtimeConnection = {
  socket: WebSocket;
  principal: WsPrincipal;
  /** The user's effective permissions, resolved once at connect (P2.3b). */
  permissions: ReadonlySet<string>;
  subjects: Set<string>;
};

/**
 * In-memory registry of realtime connections + subscriptions and the fan-out
 * path (P2.3 / ADR-0035). Single-process today; cross-instance fan-out (Redis
 * pub/sub) is the documented next step. `broadcast()` is the seam the event
 * plane drives in P2.3b — for P2.3a it's exercised directly.
 */
@Injectable()
export class RealtimeRegistryService {
  private readonly logger = new Logger(RealtimeRegistryService.name);
  private readonly connections = new Map<WebSocket, RealtimeConnection>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  add(
    socket: WebSocket,
    principal: WsPrincipal,
    permissions: ReadonlySet<string>,
  ): RealtimeConnection {
    const conn: RealtimeConnection = {
      socket,
      principal,
      permissions,
      subjects: new Set(),
    };
    this.connections.set(socket, conn);
    return conn;
  }

  remove(socket: WebSocket): void {
    this.connections.delete(socket);
  }

  get(socket: WebSocket): RealtimeConnection | undefined {
    return this.connections.get(socket);
  }

  /**
   * Accept a subscription only when it (1) is scoped to the connection's own
   * tenant (isolation), (2) names an aggregate type the user is authorised to
   * read — fail-closed via {@link requiredPermissionForSubject} + the perms
   * resolved at connect (P2.3b), and (3) is within the per-connection cap.
   * Anything else is returned as `rejected`.
   */
  subscribe(
    conn: RealtimeConnection,
    subjects: string[],
  ): { accepted: string[]; rejected: string[] } {
    const cap = this.config.get("REALTIME_MAX_SUBSCRIPTIONS", { infer: true });
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const subject of subjects) {
      const required = requiredPermissionForSubject(subject);
      const allowed =
        isSubjectWithinTenant(subject, conn.principal.tenantId) &&
        required !== null &&
        conn.permissions.has(required) &&
        conn.subjects.size < cap;
      if (allowed) {
        conn.subjects.add(subject);
        accepted.push(subject);
      } else {
        rejected.push(subject);
      }
    }
    return { accepted, rejected };
  }

  unsubscribe(conn: RealtimeConnection, subjects: string[]): void {
    for (const s of subjects) conn.subjects.delete(s);
  }

  /**
   * Push an event to every connection subscribed to a matching subject. The
   * subject encodes the tenant scope and subscriptions are tenant-confined at
   * subscribe time, so a match implies same-tenant delivery. Returns the number
   * of sockets delivered to.
   */
  broadcast(subject: string, payload: Record<string, unknown>): number {
    const message: RealtimeServerMessage = { type: "event", subject, payload };
    const frame = JSON.stringify(message);
    let delivered = 0;
    for (const conn of this.connections.values()) {
      for (const pattern of conn.subjects) {
        if (subjectMatches(pattern, subject)) {
          this.rawSend(conn.socket, frame);
          delivered++;
          break;
        }
      }
    }
    return delivered;
  }

  stats(): { connections: number; subscriptions: number } {
    let subscriptions = 0;
    for (const conn of this.connections.values()) {
      subscriptions += conn.subjects.size;
    }
    return { connections: this.connections.size, subscriptions };
  }

  /** Close every socket (graceful shutdown). */
  closeAll(): void {
    for (const conn of this.connections.values()) {
      try {
        conn.socket.close(1001, "server shutdown");
      } catch {
        /* already closing */
      }
    }
    this.connections.clear();
  }

  send(conn: RealtimeConnection, message: RealtimeServerMessage): void {
    this.rawSend(conn.socket, JSON.stringify(message));
  }

  private rawSend(socket: WebSocket, data: string): void {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    } catch (err) {
      this.logger.debug(
        `ws send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
