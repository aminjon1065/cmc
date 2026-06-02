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
 * The dynamic database-secrets engine (short-lived `cmc_app` credentials with
 * lease renewal) and the Vault Agent sidecar are the documented prod follow-on
 * (ADR-0044) — this first cut is a static KV read.
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
  const token = env.VAULT_TOKEN;
  const mount = env.VAULT_KV_MOUNT ?? "secret";
  const path = (env.VAULT_SECRET_PATH ?? "cmc/api").replace(/^\/+|\/+$/g, "");

  if (!token) {
    throw new Error(
      "VAULT_ENABLED=true but VAULT_TOKEN is not set — cannot authenticate to Vault.",
    );
  }

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
