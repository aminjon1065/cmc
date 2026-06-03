import { Logger } from "@nestjs/common";
import { resolveVaultToken } from "./vault-secrets";

/**
 * Dynamic database credentials via the Vault database secrets engine
 * (P4.7b / ADR-0065).
 *
 * When `VAULT_DB_CREDS_ENABLED=true`, this boot loader leases short-lived
 * Postgres credentials from `{VAULT_DB_MOUNT}/creds/{VAULT_DB_ROLE}` and **swaps
 * them into `DATABASE_URL`'s userinfo** (host / port / database / query kept) —
 * so the app connects with a per-process, expiring username/password while every
 * `ConfigService.get("DATABASE_URL")` stays unchanged. It runs at boot (after
 * `loadVaultSecrets`, before `loadConfig`), mirroring the KV loader, and reuses
 * the same auth (`resolveVaultToken`: token | approle).
 *
 * Off by default → pure no-op (static `DATABASE_URL`), so dev/test/CI need no
 * Vault. A plain async function with injectable `env`+`fetch` → hermetically
 * testable without a live Vault; the real DB engine is a manual live-smoke.
 *
 * `DATABASE_OWNER_URL` (migrations/bootstrap) is intentionally left static — the
 * dynamic role is the app's runtime `cmc_app` connection, not the owner.
 */

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export interface VaultDbCredsResult {
  /** Whether the loader actually ran (VAULT_DB_CREDS_ENABLED) vs short-circuited. */
  enabled: boolean;
  /** Vault lease id (for renewal); null when disabled. */
  leaseId: string | null;
  /** Lease TTL in seconds (0 when disabled). */
  leaseDuration: number;
  /** The dynamic DB username (never the password). */
  username: string | null;
}

function isEnabled(env: Env): boolean {
  return (env.VAULT_DB_CREDS_ENABLED ?? "").toLowerCase() === "true";
}

export async function loadVaultDbCredentials(
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<VaultDbCredsResult> {
  if (!isEnabled(env)) {
    return { enabled: false, leaseId: null, leaseDuration: 0, username: null };
  }

  const logger = new Logger("VaultDbCreds");
  const addr = (env.VAULT_ADDR ?? "http://localhost:8200").replace(/\/+$/, "");
  const mount = (env.VAULT_DB_MOUNT ?? "database").replace(/^\/+|\/+$/g, "");
  const role = env.VAULT_DB_ROLE;
  if (!role) {
    throw new Error(
      "VAULT_DB_CREDS_ENABLED=true but VAULT_DB_ROLE is not set.",
    );
  }
  const base = env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "VAULT_DB_CREDS_ENABLED=true but DATABASE_URL (the connection shape) is not set.",
    );
  }

  const token = await resolveVaultToken(env, fetchImpl, addr, logger);
  const url = `${addr}/v1/${mount}/creds/${role}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { "X-Vault-Token": token } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Vault DB-creds request to ${url} failed: ${msg}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Vault DB-creds read ${url} returned ${res.status} ${res.statusText}${
        body ? ` — ${body}` : ""
      }`,
    );
  }

  const json = (await res.json()) as {
    lease_id?: string;
    lease_duration?: number;
    data?: { username?: string; password?: string };
  };
  const username = json.data?.username;
  const password = json.data?.password;
  if (!username || !password) {
    throw new Error("Vault DB-creds response missing username/password.");
  }

  // Swap the leased creds into DATABASE_URL's userinfo (the URL setters
  // percent-encode), keeping host / port / database / query intact.
  let composed: string;
  try {
    const u = new URL(base);
    u.username = username;
    u.password = password;
    composed = u.toString();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`DATABASE_URL is not a valid URL: ${msg}`);
  }
  env.DATABASE_URL = composed;

  const leaseId = json.lease_id ?? null;
  const leaseDuration = json.lease_duration ?? 0;
  // Log the username + lease only — NEVER the password or the composed URL.
  logger.log(
    `leased dynamic DB credentials (user=${username}, lease=${leaseDuration}s) from ${mount}/creds/${role}`,
  );
  return { enabled: true, leaseId, leaseDuration, username };
}

/**
 * Renew a Vault lease (keeps the leased creds valid up to their max_ttl).
 * Returns the new lease duration (seconds). Re-resolves a token each call —
 * fine for the low renewal cadence (~half the lease).
 */
export async function renewVaultLease(
  leaseId: string,
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<number> {
  const logger = new Logger("VaultDbCreds");
  const addr = (env.VAULT_ADDR ?? "http://localhost:8200").replace(/\/+$/, "");
  const token = await resolveVaultToken(env, fetchImpl, addr, logger);
  const url = `${addr}/v1/sys/leases/renew`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ lease_id: leaseId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Vault lease renew returned ${res.status} ${res.statusText}${
        body ? ` — ${body}` : ""
      }`,
    );
  }
  const json = (await res.json()) as { lease_duration?: number };
  return json.lease_duration ?? 0;
}
