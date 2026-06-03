import { Logger } from "@nestjs/common";

/**
 * In-process Vault secret loader (P2.14 / ADR-0044).
 *
 * When `VAULT_ENABLED=true`, this fetches a single KV v2 secret from HashiCorp
 * Vault at boot and overlays each of its keys into `process.env` **before**
 * `loadConfig()` validates the environment. The effect: secrets (today
 * `MFA_ENC_KEY`) come from Vault, while every `ConfigService.get(...)` call in
 * the app stays byte-for-byte unchanged — they just see the overlaid value.
 *
 * Off by default → pure no-op, so dev/test/CI need no running Vault (the
 * gated-seam convention used across the codebase). It is a plain async function
 * (not a Nest provider) because it must run before the DI container — and before
 * `loadConfig()` — in `main.ts`. `env` and `fetchImpl` are parameters so the
 * loader is hermetically testable without a live Vault.
 *
 * Production auth (P4.7a / ADR-0065): `VAULT_AUTH_METHOD` selects `token` (dev:
 * `VAULT_TOKEN`) or `approle` (prod: `VAULT_ROLE_ID`+`VAULT_SECRET_ID` → a
 * short-lived client token via the AppRole login). The dynamic database-secrets
 * engine (short-lived `cmc_app` credentials with lease renewal) is P4.7b.
 */

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export interface VaultLoadResult {
  /** Whether the loader actually ran (VAULT_ENABLED) vs short-circuited. */
  enabled: boolean;
  /** Names (never values) of the env keys overlaid from Vault. */
  loaded: string[];
}

function isEnabled(env: Env): boolean {
  return (env.VAULT_ENABLED ?? "").toLowerCase() === "true";
}

export async function loadVaultSecrets(
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<VaultLoadResult> {
  if (!isEnabled(env)) return { enabled: false, loaded: [] };

  const logger = new Logger("VaultSecrets");
  const addr = (env.VAULT_ADDR ?? "http://localhost:8200").replace(/\/+$/, "");
  const mount = env.VAULT_KV_MOUNT ?? "secret";
  const path = (env.VAULT_SECRET_PATH ?? "cmc/api").replace(/^\/+|\/+$/g, "");

  // P4.7a: resolve a Vault token via the configured auth method — `token` (dev)
  // or `approle` (prod) — then read KV v2 with it.
  const token = await resolveVaultToken(env, fetchImpl, addr, logger);

  // KV v2 read API: GET /v1/{mount}/data/{path}; the secret map is at .data.data
  // (the outer .data also carries .metadata — version, created_time, etc.).
  const url = `${addr}/v1/${mount}/data/${path}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { "X-Vault-Token": token } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Vault request to ${url} failed: ${msg}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Vault read ${url} returned ${res.status} ${res.statusText}${
        body ? ` — ${body}` : ""
      }`,
    );
  }

  const json = (await res.json()) as {
    data?: { data?: Record<string, unknown> };
  };
  const secrets = json.data?.data ?? {};

  const loaded: string[] = [];
  for (const [key, value] of Object.entries(secrets)) {
    if (value == null) continue;
    // Vault is the source of truth when enabled — it overrides any value that
    // dotenv already placed in env.
    env[key] = typeof value === "string" ? value : String(value);
    loaded.push(key);
  }

  // Log key NAMES only, never values.
  logger.log(
    `loaded ${loaded.length} secret(s) from Vault ${mount}/${path}` +
      (loaded.length ? `: ${loaded.join(", ")}` : ""),
  );
  return { enabled: true, loaded };
}

/**
 * Resolve a usable Vault token (P4.7a). `token` (default, dev) returns
 * `VAULT_TOKEN` directly; `approle` (prod) performs the AppRole login
 * (`POST /v1/auth/{mount}/login` with `role_id`+`secret_id`) and returns the
 * issued `client_token`. Throws (never silently degrades) when the required
 * inputs are missing or the login fails.
 */
export async function resolveVaultToken(
  env: Env,
  fetchImpl: FetchLike,
  addr: string,
  logger: Logger,
): Promise<string> {
  const method = (env.VAULT_AUTH_METHOD ?? "token").toLowerCase();

  if (method === "approle") {
    const roleId = env.VAULT_ROLE_ID;
    const secretId = env.VAULT_SECRET_ID;
    if (!roleId || !secretId) {
      throw new Error(
        "VAULT_AUTH_METHOD=approle requires VAULT_ROLE_ID and VAULT_SECRET_ID.",
      );
    }
    const mount = (env.VAULT_APPROLE_MOUNT ?? "approle").replace(
      /^\/+|\/+$/g,
      "",
    );
    const url = `${addr}/v1/auth/${mount}/login`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Vault AppRole login to ${url} failed: ${msg}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Vault AppRole login ${url} returned ${res.status} ${res.statusText}${
          body ? ` — ${body}` : ""
        }`,
      );
    }
    const json = (await res.json()) as { auth?: { client_token?: string } };
    const clientToken = json.auth?.client_token;
    if (!clientToken) {
      throw new Error("Vault AppRole login returned no client_token.");
    }
    logger.log("authenticated to Vault via AppRole");
    return clientToken;
  }

  // Default: static token (dev-mode root token, or a pre-issued token).
  const token = env.VAULT_TOKEN;
  if (!token) {
    throw new Error(
      "VAULT_ENABLED=true with token auth but VAULT_TOKEN is not set — cannot authenticate to Vault.",
    );
  }
  return token;
}
