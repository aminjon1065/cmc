import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";

/** DI token for the ClickHouse client (P2.5 / ADR-0033). */
export const CLICKHOUSE_CLIENT = Symbol("CLICKHOUSE_CLIENT");

/** Thin ClickHouse seam — faked in tests; real driver loaded only when enabled. */
export interface ClickHouseClient {
  readonly active: boolean;
  insert(table: string, rows: Record<string, unknown>[]): Promise<void>;
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Disabled client — analytics consumers see `active=false` and idle. */
export class NoopClickHouseClient implements ClickHouseClient {
  readonly active = false;
  async insert(): Promise<void> {}
  async query<T = Record<string, unknown>>(): Promise<T[]> {
    return [];
  }
  async ping(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {}
}

/**
 * Factory: a real ClickHouse client when enabled, else the noop. The
 * `@clickhouse/client` package is **dynamic-imported** only when enabled, so it
 * never loads under jest (where CLICKHOUSE_ENABLED is false and tests fake this
 * token).
 */
export async function createClickHouseClient(
  config: ConfigService<AppConfig, true>,
): Promise<ClickHouseClient> {
  if (!config.get("CLICKHOUSE_ENABLED", { infer: true })) {
    return new NoopClickHouseClient();
  }
  const { RealClickHouseClient } = await import("./clickhouse-client.impl");
  return new RealClickHouseClient({
    url: config.get("CLICKHOUSE_URL", { infer: true }),
    database: config.get("CLICKHOUSE_DATABASE", { infer: true }),
    username: config.get("CLICKHOUSE_USER", { infer: true }),
    password: config.get("CLICKHOUSE_PASSWORD", { infer: true }),
  });
}
