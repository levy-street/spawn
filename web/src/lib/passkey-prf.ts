/**
 * WebAuthn PRF: the secret that unlocks the operator's trust bundle.
 *
 * The `prf` extension evaluates a pseudo-random function inside the
 * authenticator at a fixed, domain-separated input. The result never leaves the
 * device unencrypted and the server never sees it, which is exactly the
 * property the trust bundle needs — see docs/TRUST.md "how a new device
 * bootstraps trust".
 *
 * What the server may hold without weakening anything: the credential IDs, so a
 * device knows which passkey to ask for. Those are not secret. A server that
 * substitutes a credential ID it controls only causes the unlock to fail — it
 * cannot learn or forge the secret, because that lives in the authenticator.
 * Corrupting this list is a denial of service, not a disclosure.
 *
 * Availability, not confidentiality, is the weak point: PRF support varies by
 * platform and authenticator, which is why the ADR keeps endorsement as a
 * fallback rather than making this the only path.
 */

/** Domain separation: hashed to a fixed 32-byte PRF input. */
const TRUST_PRF_SALT_INFO = "SPAWN-TRUST-BUNDLE-PRF-V1";
const PRF_SECRET_BYTES = 32;
const CHALLENGE_BYTES = 32;

export type PasskeyPrfErrorCode =
  | "unsupported"
  | "prf_unavailable"
  | "no_credential"
  | "cancelled"
  | "invalid_account"
  | "invalid_secret";

export class PasskeyPrfError extends Error {
  constructor(
    readonly code: PasskeyPrfErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PasskeyPrfError";
  }
}

/**
 * The slice of WebAuthn this module uses, injectable so the logic is testable
 * without a real authenticator.
 */
export interface PasskeyCredentialsApi {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}

export interface PasskeyPrfOptions {
  readonly credentials?: PasskeyCredentialsApi;
  /** Overridable for tests; defaults to the current origin's host. */
  readonly rpId?: string;
  readonly rpName?: string;
}

/** PRF results are not in the DOM lib yet. */
interface PrfExtensionResults {
  readonly enabled?: boolean;
  readonly results?: { readonly first?: ArrayBuffer };
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireAccountId(accountId: string): void {
  if (!CANONICAL_UUID.test(accountId)) {
    throw new PasskeyPrfError("invalid_account", "account ID is not a canonical UUID");
  }
}

function resolveCredentials(options: PasskeyPrfOptions): PasskeyCredentialsApi {
  const api = options.credentials ?? globalThis.navigator?.credentials;
  if (api === undefined || typeof api.get !== "function" || typeof api.create !== "function") {
    throw new PasskeyPrfError("unsupported", "WebAuthn is unavailable in this context");
  }
  return api as PasskeyCredentialsApi;
}

/**
 * Whether this context could support the passkey path at all.
 *
 * Deliberately does not claim PRF works: only an actual authenticator
 * interaction can establish that, so callers must still handle
 * `prf_unavailable` and fall back to endorsement.
 */
export function isPasskeySupported(options: PasskeyPrfOptions = {}): boolean {
  try {
    resolveCredentials(options);
    return typeof globalThis.PublicKeyCredential !== "undefined";
  } catch {
    return false;
  }
}

/** Fixed PRF input, so the same passkey always yields the same bundle key. */
async function trustPrfSalt(): Promise<ArrayBuffer> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new PasskeyPrfError("unsupported", "WebCrypto is unavailable in this context");
  }
  return subtle.digest("SHA-256", new TextEncoder().encode(TRUST_PRF_SALT_INFO));
}

function randomChallenge(): ArrayBuffer {
  // The server never verifies these assertions -- the PRF secret is derived and
  // used entirely client-side -- so the challenge only needs to be fresh, not
  // server-issued. If passkeys later become an authentication factor, that
  // flow needs its own server-issued challenge and must not reuse this one.
  const challenge = new Uint8Array(CHALLENGE_BYTES);
  crypto.getRandomValues(challenge);
  return challenge.buffer;
}

function encodeCredentialId(raw: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(raw)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCredentialId(value: string): ArrayBuffer {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out.buffer;
}

function prfResults(credential: Credential): PrfExtensionResults | undefined {
  const assertion = credential as PublicKeyCredential;
  if (typeof assertion.getClientExtensionResults !== "function") return undefined;
  return (assertion.getClientExtensionResults() as { prf?: PrfExtensionResults }).prf;
}

export interface TrustPasskey {
  readonly credentialId: string;
  /**
   * Whether the authenticator reported PRF support at creation. False means the
   * caller must fall back to endorsement rather than assume a later unlock will
   * work.
   */
  readonly prfEnabled: boolean;
}

/**
 * Create a passkey for unlocking this account's trust bundle.
 *
 * Requests PRF at creation so an authenticator that cannot do it says so now,
 * rather than after the operator believes their devices are provisioned.
 */
export async function createTrustPasskey(
  accountId: string,
  userName: string,
  options: PasskeyPrfOptions = {},
): Promise<TrustPasskey> {
  requireAccountId(accountId);
  const credentials = resolveCredentials(options);
  const salt = await trustPrfSalt();

  let created: Credential | null;
  try {
    created = await credentials.create({
      publicKey: {
        challenge: randomChallenge(),
        rp: { id: options.rpId, name: options.rpName ?? "SPAWN D" },
        user: {
          // The account UUID, not an email: this identifies the trust anchor,
          // and must stay stable if the operator changes their address.
          id: new TextEncoder().encode(accountId),
          name: userName,
          displayName: userName,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch (error) {
    throw new PasskeyPrfError(
      "cancelled",
      `passkey creation was refused or cancelled: ${String(error)}`,
    );
  }
  if (created === null) {
    throw new PasskeyPrfError("cancelled", "passkey creation returned no credential");
  }

  const prf = prfResults(created);
  return {
    credentialId: encodeCredentialId((created as PublicKeyCredential).rawId),
    // Some authenticators report support only, evaluating on a later assertion.
    prfEnabled: prf?.enabled === true || prf?.results?.first !== undefined,
  };
}

/**
 * Evaluate the PRF to obtain this account's trust-bundle secret.
 *
 * `credentialIds` narrows which passkey is asked for; an empty list lets the
 * platform offer any discoverable credential, which is what a brand-new device
 * needs since it knows nothing yet.
 */
export interface TrustPrfResult {
  /** Which enrolled credential the authenticator actually used. */
  readonly credentialId: string;
  readonly secret: Uint8Array;
}

export async function evaluateTrustPrf(
  accountId: string,
  credentialIds: readonly string[] = [],
  options: PasskeyPrfOptions = {},
): Promise<TrustPrfResult> {
  requireAccountId(accountId);
  const credentials = resolveCredentials(options);
  const salt = await trustPrfSalt();

  let assertion: Credential | null;
  try {
    assertion = await credentials.get({
      publicKey: {
        challenge: randomChallenge(),
        rpId: options.rpId,
        userVerification: "required",
        allowCredentials: credentialIds.map((id) => ({
          type: "public-key" as const,
          id: decodeCredentialId(id),
        })),
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch (error) {
    throw new PasskeyPrfError(
      "cancelled",
      `passkey assertion was refused or cancelled: ${String(error)}`,
    );
  }
  if (assertion === null) {
    throw new PasskeyPrfError("no_credential", "no passkey was available for this account");
  }

  const first = prfResults(assertion)?.results?.first;
  if (first === undefined) {
    // The authenticator exists but will not evaluate the PRF. Distinct from
    // cancellation: the operator did nothing wrong and endorsement is the path.
    throw new PasskeyPrfError(
      "prf_unavailable",
      "this passkey cannot derive a trust secret; use device endorsement instead",
    );
  }
  const secret = new Uint8Array(first);
  if (secret.byteLength < PRF_SECRET_BYTES) {
    throw new PasskeyPrfError("invalid_secret", "PRF secret is shorter than required");
  }
  // Which credential was used matters to the envelope: its wrap is keyed by ID.
  return { credentialId: encodeCredentialId((assertion as PublicKeyCredential).rawId), secret };
}
