import { loadVaultSecrets } from "../../src/config/vault-secrets";

/**
 * Vault secret loader (P2.14 / ADR-0044). Hermetic: the loader takes `env` and
 * `fetch` as parameters, so these exercise the full gating + KV v2 overlay +
 * error paths with a faked fetch and a throwaway env — no Vault container, no
 * app boot. The live smoke (real Vault dev container) is run manually.
 */
describe("Vault secrets loader", () => {
  function kvResponse(data: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ data: { data } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("is a no-op when VAULT_ENABLED is not 'true'", async () => {
    const env = { VAULT_ENABLED: "false", MFA_ENC_KEY: "from-env" };
    const spy = jest.fn();
    const res = await loadVaultSecrets(env, spy as unknown as typeof fetch);

    expect(res).toEqual({ enabled: false, loaded: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(env.MFA_ENC_KEY).toBe("from-env"); // untouched
  });

  it("reads KV v2 and overlays secret keys into env (Vault overrides env)", async () => {
    const env: Record<string, string | undefined> = {
      VAULT_ENABLED: "true",
      VAULT_ADDR: "http://vault.example:8200/", // trailing slash trimmed
      VAULT_TOKEN: "root-token",
      VAULT_KV_MOUNT: "secret",
      VAULT_SECRET_PATH: "cmc/api",
      MFA_ENC_KEY: "from-env", // expect override
    };
    const spy = jest.fn(async (_url: string, _init: RequestInit) =>
      kvResponse({ MFA_ENC_KEY: "from-vault", EXTRA_SECRET: "xyz" }),
    );

    const res = await loadVaultSecrets(env, spy as unknown as typeof fetch);

    expect(res.enabled).toBe(true);
    expect(res.loaded.sort()).toEqual(["EXTRA_SECRET", "MFA_ENC_KEY"]);
    // Correct KV v2 read URL + token header.
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]!;
    expect(call[0]).toBe("http://vault.example:8200/v1/secret/data/cmc/api");
    expect((call[1].headers as Record<string, string>)["X-Vault-Token"]).toBe(
      "root-token",
    );
    // Overlay applied; Vault wins over the pre-existing env value.
    expect(env.MFA_ENC_KEY).toBe("from-vault");
    expect(env.EXTRA_SECRET).toBe("xyz");
  });

  it("throws when enabled without a token", async () => {
    const env = { VAULT_ENABLED: "true" };
    const spy = jest.fn();
    await expect(
      loadVaultSecrets(env, spy as unknown as typeof fetch),
    ).rejects.toThrow(/VAULT_TOKEN/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws on a non-OK Vault response", async () => {
    const env = { VAULT_ENABLED: "true", VAULT_TOKEN: "bad" };
    const spy = jest.fn(
      async () =>
        new Response("permission denied", {
          status: 403,
          statusText: "Forbidden",
        }),
    );
    await expect(
      loadVaultSecrets(env, spy as unknown as typeof fetch),
    ).rejects.toThrow(/403/);
  });

  it("tolerates an empty secret (no keys) without error", async () => {
    const env = { VAULT_ENABLED: "true", VAULT_TOKEN: "root" };
    const spy = jest.fn(async () => kvResponse({}));
    const res = await loadVaultSecrets(env, spy as unknown as typeof fetch);
    expect(res).toEqual({ enabled: true, loaded: [] });
  });
});
