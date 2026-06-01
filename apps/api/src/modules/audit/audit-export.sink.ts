import { Logger } from "@nestjs/common";
import { appendFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";

/** DI token for the configured export sink (P1.12 / ADR-0030). */
export const AUDIT_EXPORT_SINK = Symbol("AUDIT_EXPORT_SINK");

/** Where formatted SIEM lines are shipped. Swapped with a fake in tests. */
export interface AuditExportSink {
  readonly transport: string;
  write(lines: string[]): Promise<void>;
}

/** Default — format-but-discard, so nothing leaks until a SIEM is configured. */
export class NoopSink implements AuditExportSink {
  readonly transport = "noop";
  async write(): Promise<void> {}
}

export class StdoutSink implements AuditExportSink {
  readonly transport = "stdout";
  async write(lines: string[]): Promise<void> {
    for (const line of lines) process.stdout.write(`${line}\n`);
  }
}

export class FileSink implements AuditExportSink {
  readonly transport = "file";
  constructor(private readonly path: string) {}
  async write(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    await appendFile(this.path, `${lines.join("\n")}\n`, "utf8");
  }
}

/** Syslog over TCP with RFC 6587 octet-counting framing (one connection/batch). */
export class TcpSink implements AuditExportSink {
  readonly transport = "tcp";
  private readonly logger = new Logger("AuditExportTcpSink");
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}
  async write(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const payload = lines
      .map((l) => `${Buffer.byteLength(l, "utf8")} ${l}`)
      .join("");
    await new Promise<void>((resolve, reject) => {
      const socket: Socket = createConnection(
        { host: this.host, port: this.port },
        () => socket.write(payload, "utf8", () => socket.end()),
      );
      socket.once("error", reject);
      socket.once("close", () => resolve());
    });
  }
}

export function createAuditExportSink(
  config: ConfigService<AppConfig, true>,
): AuditExportSink {
  switch (config.get("AUDIT_EXPORT_TRANSPORT", { infer: true })) {
    case "file":
      return new FileSink(config.get("AUDIT_EXPORT_FILE", { infer: true }));
    case "tcp":
      return new TcpSink(
        config.get("AUDIT_EXPORT_TCP_HOST", { infer: true }),
        config.get("AUDIT_EXPORT_TCP_PORT", { infer: true }),
      );
    case "stdout":
      return new StdoutSink();
    default:
      return new NoopSink();
  }
}
