import { describe, expect, test } from "bun:test";
import {
  createTrustPasskey,
  evaluateTrustPrf,
  isPasskeySupported,
  type PasskeyCredentialsApi,
  PasskeyPrfError,
} from "./passkey-prf";
import { openTrustEnvelope, sealTrustEnvelope } from "./trust-envelope";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";

/** A fake authenticator: a real PRF is a keyed function of the salt. */
function authenticator(
  options: {
    readonly prf?: "results" | "enabled-only" | "absent";
    readonly key?: number;
    readonly rejects?: boolean;
    readonly returnsNull?: boolean;
  } = {},
): PasskeyCredentialsApi & { lastSalt?: ArrayBuffer; lastAllow?: readonly unknown[] } {
  const mode = options.prf ?? "results";
  const api = {
    lastSalt: undefined as ArrayBuffer | undefined,
    lastAllow: undefined as readonly unknown[] | undefined,
    async create(request: CredentialCreationOptions) {
      if (options.rejects) throw new Error("user cancelled");
      if (options.returnsNull) return null;
      const extensions = request.publicKey?.extensions as
        | { prf?: { eval?: { first?: ArrayBuffer } } }
        | undefined;
      api.lastSalt = extensions?.prf?.eval?.first;
      return credential(api.lastSalt);
    },
    async get(request: CredentialRequestOptions) {
      if (options.rejects) throw new Error("user cancelled");
      if (options.returnsNull) return null;
      const extensions = request.publicKey?.extensions as
        | { prf?: { eval?: { first?: ArrayBuffer } } }
        | undefined;
      api.lastSalt = extensions?.prf?.eval?.first;
      api.lastAllow = request.publicKey?.allowCredentials;
      return credential(api.lastSalt);
    },
  };

  function credential(salt: ArrayBuffer | undefined): Credential {
    // Derive deterministically from salt + device key, like a real PRF.
    const secret = new Uint8Array(32);
    const saltBytes = salt ? new Uint8Array(salt) : new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) secret[i] = (saltBytes[i] ?? 0) ^ (options.key ?? 1);
    const prf =
      mode === "results"
        ? { enabled: true, results: { first: secret.buffer } }
        : mode === "enabled-only"
          ? { enabled: true }
          : undefined;
    return {
      rawId: new Uint8Array([1, 2, 3, 4]).buffer,
      getClientExtensionResults: () => ({ prf }),
    } as unknown as Credential;
  }

  return api;
}

describe("passkey PRF", () => {
  test("creation reports PRF support so the caller knows the path is viable", async () => {
    const credentials = authenticator({ prf: "results" });
    const passkey = await createTrustPasskey(ACCOUNT, "op@example.com", { credentials });
    expect(passkey.prfEnabled).toBe(true);
    expect(passkey.credentialId).toBe("AQIDBA");
  });

  test("an authenticator without PRF is reported, not assumed working", async () => {
    const credentials = authenticator({ prf: "absent" });
    const passkey = await createTrustPasskey(ACCOUNT, "op@example.com", { credentials });
    expect(passkey.prfEnabled).toBe(false);
  });

  test("PRF-capable-but-not-yet-evaluated still counts as enabled", async () => {
    const credentials = authenticator({ prf: "enabled-only" });
    const passkey = await createTrustPasskey(ACCOUNT, "op@example.com", { credentials });
    expect(passkey.prfEnabled).toBe(true);
  });

  test("evaluation yields a 32-byte secret at a domain-separated salt", async () => {
    const credentials = authenticator();
    const { secret, credentialId } = await evaluateTrustPrf(ACCOUNT, [], { credentials });
    expect(secret.byteLength).toBe(32);
    expect(credentialId).toBe("AQIDBA");
    // The salt is the SHA-256 of the domain string, not the raw string.
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("SPAWN-TRUST-BUNDLE-PRF-V1")),
    );
    expect(new Uint8Array(credentials.lastSalt as ArrayBuffer)).toEqual(expected);
  });

  test("the same authenticator reproduces the same secret", async () => {
    const first = await evaluateTrustPrf(ACCOUNT, [], { credentials: authenticator({ key: 9 }) });
    const second = await evaluateTrustPrf(ACCOUNT, [], { credentials: authenticator({ key: 9 }) });
    expect(first.secret).toEqual(second.secret);
  });

  test("a different authenticator yields a different secret", async () => {
    const mine = await evaluateTrustPrf(ACCOUNT, [], { credentials: authenticator({ key: 1 }) });
    const theirs = await evaluateTrustPrf(ACCOUNT, [], { credentials: authenticator({ key: 2 }) });
    expect(mine.secret).not.toEqual(theirs.secret);
  });

  test("an authenticator that will not evaluate PRF is distinguishable from cancellation", async () => {
    // This distinction decides whether the UI offers endorsement or a retry.
    const credentials = authenticator({ prf: "enabled-only" });
    try {
      await evaluateTrustPrf(ACCOUNT, [], { credentials });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PasskeyPrfError);
      expect((error as PasskeyPrfError).code).toBe("prf_unavailable");
    }
  });

  test("cancellation is reported as cancellation", async () => {
    const credentials = authenticator({ rejects: true });
    try {
      await evaluateTrustPrf(ACCOUNT, [], { credentials });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as PasskeyPrfError).code).toBe("cancelled");
    }
  });

  test("no available credential is reported distinctly", async () => {
    const credentials = authenticator({ returnsNull: true });
    try {
      await evaluateTrustPrf(ACCOUNT, [], { credentials });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as PasskeyPrfError).code).toBe("no_credential");
    }
  });

  test("an empty credential list lets a new device use any discoverable passkey", async () => {
    const credentials = authenticator();
    await evaluateTrustPrf(ACCOUNT, [], { credentials });
    expect(credentials.lastAllow).toEqual([]);
  });

  test("credential IDs round-trip into the assertion request", async () => {
    const credentials = authenticator();
    await evaluateTrustPrf(ACCOUNT, ["AQIDBA"], { credentials });
    const allow = credentials.lastAllow as ReadonlyArray<{ id: ArrayBuffer; type: string }>;
    expect(allow).toHaveLength(1);
    expect(new Uint8Array(allow[0].id)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("non-canonical account IDs are refused before touching the authenticator", async () => {
    const credentials = authenticator();
    await expect(evaluateTrustPrf("not-a-uuid", [], { credentials })).rejects.toThrow(
      PasskeyPrfError,
    );
    expect(credentials.lastSalt).toBeUndefined();
  });

  test("support detection is false without WebAuthn", () => {
    expect(isPasskeySupported({ credentials: undefined })).toBe(
      typeof globalThis.PublicKeyCredential !== "undefined",
    );
  });

  test("end to end: the PRF secret opens a bundle sealed under it", async () => {
    // The property the whole path exists for: a device holding only this
    // passkey recovers the trust bundle, with the server never seeing the key.
    const credentials = authenticator({ key: 42 });
    const { secret, credentialId } = await evaluateTrustPrf(ACCOUNT, [], { credentials });
    const sealed = await sealTrustEnvelope(ACCOUNT, [], [{ credentialId, prfSecret: secret }], 1);

    const freshDevice = authenticator({ key: 42 });
    const recovered = await evaluateTrustPrf(ACCOUNT, [], { credentials: freshDevice });
    const opened = await openTrustEnvelope(ACCOUNT, sealed, {
      credentialId: recovered.credentialId,
      prfSecret: recovered.secret,
    });
    expect(opened.accountId).toBe(ACCOUNT);

    // A different authenticator must not open it.
    const attacker = await evaluateTrustPrf(ACCOUNT, [], {
      credentials: authenticator({ key: 43 }),
    });
    await expect(
      openTrustEnvelope(ACCOUNT, sealed, {
        credentialId: attacker.credentialId,
        prfSecret: attacker.secret,
      }),
    ).rejects.toThrow();
  });
});
