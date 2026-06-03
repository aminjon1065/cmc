import {
  loadVaultDbCredentials,
  renewVaultLease,
} from "../../src/config/vault-db-credentials";

/**
 * Dynamic DB credentials loader (P4.7b / ADR-0065). Hermetic: the loader takes
 * `env` and `fetch` as parameters, so these exercise the gating + DB-engine read
 * + DATABASE_URL userinfo swap + auth reuse + error paths with a faked fetch and
 * a throwaway env — no Vault container, no app boot. The real Vault DB secrets
 * engine is a manual live-smoke.
 */
describe("Vault dynamic DB credentials loader", () => {
  const BASE_URL =
    "postgresql://staticuser:staticpass@cmc-postgres:5432/cmc?sslmode=require";

  function credsResponse(
    username: string,
    password: string,
    leaseId = "database/creds/cmc-app/abc123",
    leaseDuration = 3600,
  ): Response {
    return new Response(
      JSON.stringify({
        lease_id: leaseId,
        lease_duration: leaseDuration,
        data: { username, password },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  it("is a no-op when VAULT_DB_CREDS_ENABLED is not 'true'", async () => {
    const env = { VAULT_DB_CREDS_ENABLED: "false", DATABASE_URL: BASE_URL };
    const spy = jest.fn();
    const res = await loadVaultDbCredentials(env, spy as unknown as typeof fetch);
    expect(res).toEqual({
      enabled: false,
      leaseId: null,
      leaseDuration: 0,
      username: null,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(env.DATABASE_URL).toBe(BASE_URL); // untouched
  });

  it("leases creds and swaps them into DATABASE_URL userinfo (host/db kept)", async () => {
    const env: Record<string, string | undefined> = {
      VAULT_DB_CREDS_ENABLED: "true",
      VAULT_ADDR: "http://vault.example:8200",
      VAULT_TOKEN: "root-token",
      VAULT_DB_MOUNT: "database",
      VAULT_DB_ROLE: "cmc-app",
      DATABASE_URL: BASE_URL,
    };
    const spy = jest.fn(async (_url: string, _init?: RequestInit) =>
      credsResponse("v-token-cmc_app-x1", "A1b2-C3d4"),
    );

    const res = await loadVaultDbCredentials(env, spy as unknown as typeof fetch);

    expect(res.enabled).toBe(true);
    expect(res.username).toBe("v-token-cmc_app-x1");
    expect(res.leaseId).toBe("database/creds/cmc-app/abc123");
    expect(res.leaseDuration).toBe(3600);
    // Correct DB-engine read URL + token header.
    const call = spy.mock.calls[0]!;
    expect(call[0]).toBe("http://vault.example:8200/v1/database/creds/cmc-app");
    expect((call[1]!.headers as Record<string, string>)["X-Vault-Token"]).toBe(
      "root-token",
    );
    // Creds swapped into the URL; host/port/db/query preserved.
    const swapped = new URL(env.DATABASE_URL!);
    expect(swapped.username).toBe("v-token-cmc_app-x1");
    expect(swapped.password).toBe("A1b2-C3d4");
    expect(swapped.host).toBe("cmc-postgres:5432");
    expect(swapped.pathname).toBe("/cmc");
    expect(swapped.search).toBe("?sslmode=require");
  });

  it("authenticates via AppRole before the DB-engine read", async () => {
    const env: Record<string, string | undefined> = {
      VAULT_DB_CREDS_ENABLED: "true",
      VAULT_ADDR: "http://vault.example:8200",
      VAULT_AUTH_METHOD: "approle",
      VAULT_ROLE_ID: "r1",
      VAULT_SECRET_ID: "s1",
      VAULT_DB_ROLE: "cmc-app",
      DATABASE_URL: BASE_URL,
    };
    const spy = jest.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/v1/auth/approle/login")) {
        return new Response(
          JSON.stringify({ auth: { client_token: "approle-token" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return credsResponse("dyn-user", "dyn-pass");
    });

    const res = await loadVaultDbCredentials(env, spy as unknown as typeof fetch);
    expect(res.username).toBe("dyn-user");
    // The DB-engine read used the AppRole-issued token.
    const credsCall = spy.mock.calls[1]!;
    expect(credsCall[0]).toBe(
      "http://vault.example:8200/v1/database/creds/cmc-app",
    );
    expect(
      (credsCall[1]!.headers as Record<string, string>)["X-Vault-Token"],
    ).toBe("approle-token");
    expect(new URL(env.DATABASE_URL!).username).toBe("dyn-user");
  });

  it("throws when enabled without VAULT_DB_ROLE", async () => {
    const env = { VAULT_DB_CREDS_ENABLED: "true", DATABASE_URL: BASE_URL };
    const spy = jest.fn();
    await expect(
      loadVaultDbCredentials(env, spy as unknown as typeof fetch),
    ).rejects.toThrow(/VAULT_DB_ROLE/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws when enabled without DATABASE_URL", async () => {
    const env = { VAULT_DB_CREDS_ENABLED: "true", VAULT_DB_ROLE: "cmc-app" };
    const spy = jest.fn();
    await expect(
      loadVaultDbCredentials(env, spy as unknown as typeof fetch),
    ).rejects.toThrow(/DATABASE_URL/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("renews a lease (PUT /sys/leases/renew) and returns the new TTL", async () => {
    const env = {
      VAULT_ADDR: "http://vault.example:8200",
      VAULT_TOKEN: "root-token",
    };
    const spy = jest.fn(async (_url: string, init?: RequestInit) => {
      expect(init!.method).toBe("PUT");
      expect(JSON.parse(String(init!.body))).toEqual({
        lease_id: "database/creds/cmc-app/abc123",
      });
      return new Response(JSON.stringify({ lease_duration: 7200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const ttl = await renewVaultLease(
      "database/creds/cmc-app/abc123",
      env,
      spy as unknown as typeof fetch,
    );
    expect(ttl).toBe(7200);
    expect(spy.mock.calls[0]![0]).toBe(
      "http://vault.example:8200/v1/sys/leases/renew",
    );
  });
});
