import {
  createClient,
  type ClickHouseClient as Driver,
} from "@clickhouse/client";
import type { ClickHouseClient } from "./clickhouse.client";

/**
 * Real ClickHouse client (P2.5 / ADR-0033). Loaded lazily by the factory only
 * when `CLICKHOUSE_ENABLED`, so `@clickhouse/client` never enters jest.
 */
export class RealClickHouseClient implements ClickHouseClient {
  readonly active = true;
  private readonly driver: Driver;

  constructor(opts: {
    url: string;
    database: string;
    username: string;
    password: string;
  }) {
    this.driver = createClient({
      url: opts.url,
      database: opts.database,
      username: opts.username,
      password: opts.password,
    });
  }

  async insert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    await this.driver.insert({ table, values: rows, format: "JSONEachRow" });
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const rs = await this.driver.query({ query: sql, format: "JSONEachRow" });
    return rs.json<T>();
  }

  async ping(): Promise<boolean> {
    const res = await this.driver.ping();
    return res.success;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
