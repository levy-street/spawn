import { sha256 } from "@noble/hashes/sha2.js";

import { randomBytes } from "@/lib/crypto/bootstrap";
import {
  bytesToUuid,
  decodeBase64UrlExact,
  encodeBase64Url,
  encodeUtf8,
  equalBytes,
  parseCanonicalUuid,
} from "@/lib/crypto/bytes";
import {
  deriveEd25519PublicKey,
  signPureEd25519,
  verifyPureEd25519Strict,
} from "@/lib/crypto/ed25519";
import { encodeSignedSignalV2, type SignalTranscript } from "@/lib/crypto/signed-signal";
import {
  type ApprovalTranscript,
  type EndorsementTranscript,
  encodeBrowserEndorsementV1,
  encodeBrowserRegistrationV1,
  encodeHostPairApprovalV1,
  type RegistrationTranscript,
} from "@/lib/crypto/transcripts";
import { secureStorage } from "@/lib/secure-storage";

const IDENTITY_KEY_PREFIX = "spawn.identity.ed25519.v1.";
const REGISTRATION_KEY_PREFIX = "spawn.identity.registration.v1.";
const SELF_TEST = encodeUtf8("SPAWN-NATIVE-IDENTITY-SELF-TEST-V1");

interface StoredIdentityV1 {
  version: 1;
  accountId: string;
  secretKey: string;
  publicKey: string;
}

let activeAccountId: string | null = null;
let identityLock: Promise<void> = Promise.resolve();
const resetHandlers = new Set<(accountId: string) => Promise<void>>();

export class DeviceIdentityError extends Error {
  constructor(
    readonly code: "IDENTITY_ABSENT" | "IDENTITY_CORRUPT" | "IDENTITY_STORAGE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "DeviceIdentityError";
  }
}

function identityKey(accountId: string): string {
  return `${IDENTITY_KEY_PREFIX}${parseCanonicalUuid(accountId)}`;
}

export function deviceRegistrationStorageKey(accountId: string): string {
  return `${REGISTRATION_KEY_PREFIX}${parseCanonicalUuid(accountId)}`;
}

export function setDeviceIdentityAccount(accountId: string): void {
  activeAccountId = parseCanonicalUuid(accountId);
}

export function clearDeviceIdentityAccount(): void {
  activeAccountId = null;
}

export function onDeviceIdentityReset(handler: (accountId: string) => Promise<void>): () => void {
  resetHandlers.add(handler);
  return () => resetHandlers.delete(handler);
}

function currentAccount(): string {
  if (activeAccountId === null) {
    throw new DeviceIdentityError(
      "IDENTITY_ABSENT",
      "Device identity account must be selected before use",
    );
  }
  return activeAccountId;
}

function exactRecord(value: unknown, accountId: string): StoredIdentityV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeviceIdentityError("IDENTITY_CORRUPT", "Device identity record is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["accountId", "publicKey", "secretKey", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new DeviceIdentityError("IDENTITY_CORRUPT", "Device identity record has invalid fields");
  }
  if (
    record["version"] !== 1 ||
    record["accountId"] !== accountId ||
    typeof record["secretKey"] !== "string" ||
    typeof record["publicKey"] !== "string"
  ) {
    throw new DeviceIdentityError("IDENTITY_CORRUPT", "Device identity record is invalid");
  }
  return {
    version: 1,
    accountId,
    secretKey: record["secretKey"],
    publicKey: record["publicKey"],
  };
}

function validateRecord(record: StoredIdentityV1): { seed: Uint8Array; publicKey: Uint8Array } {
  const seed = decodeBase64UrlExact(record.secretKey, 32);
  try {
    const publicKey = decodeBase64UrlExact(record.publicKey, 32);
    const derived = deriveEd25519PublicKey(seed);
    if (!equalBytes(publicKey, derived)) {
      throw new DeviceIdentityError("IDENTITY_CORRUPT", "Device identity keys do not match");
    }
    const signature = signPureEd25519(seed, SELF_TEST);
    if (!verifyPureEd25519Strict(publicKey, SELF_TEST, signature)) {
      throw new DeviceIdentityError("IDENTITY_CORRUPT", "Device identity self-test failed");
    }
    signature.fill(0);
    derived.fill(0);
    return { seed, publicKey };
  } catch (error) {
    seed.fill(0);
    if (error instanceof DeviceIdentityError) throw error;
    throw new DeviceIdentityError("IDENTITY_CORRUPT", "Device identity record cannot be decoded");
  }
}

async function readRecord(accountId: string): Promise<StoredIdentityV1 | null> {
  let encoded: string | null;
  try {
    encoded = await secureStorage.get(identityKey(accountId));
  } catch {
    throw new DeviceIdentityError(
      "IDENTITY_STORAGE_UNAVAILABLE",
      "Device identity storage is unavailable",
    );
  }
  if (encoded === null) return null;
  try {
    return exactRecord(JSON.parse(encoded) as unknown, accountId);
  } catch (error) {
    if (error instanceof DeviceIdentityError) throw error;
    throw new DeviceIdentityError("IDENTITY_CORRUPT", "Device identity record is not valid JSON");
  }
}

async function withLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = identityLock.then(operation, operation);
  identityLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function ensureForAccount(accountId: string): Promise<StoredIdentityV1> {
  return withLock(async () => {
    const existing = await readRecord(accountId);
    if (existing !== null) {
      const loaded = validateRecord(existing);
      loaded.seed.fill(0);
      loaded.publicKey.fill(0);
      return existing;
    }

    const seed = randomBytes(32);
    try {
      const publicKey = deriveEd25519PublicKey(seed);
      const candidate: StoredIdentityV1 = {
        version: 1,
        accountId,
        secretKey: encodeBase64Url(seed),
        publicKey: encodeBase64Url(publicKey),
      };
      publicKey.fill(0);
      try {
        await secureStorage.set(identityKey(accountId), JSON.stringify(candidate));
      } catch {
        throw new DeviceIdentityError(
          "IDENTITY_STORAGE_UNAVAILABLE",
          "Device identity could not be stored",
        );
      }
      const winner = await readRecord(accountId);
      if (winner === null) {
        throw new DeviceIdentityError(
          "IDENTITY_STORAGE_UNAVAILABLE",
          "Device identity disappeared after storage",
        );
      }
      const loaded = validateRecord(winner);
      loaded.seed.fill(0);
      loaded.publicKey.fill(0);
      return winner;
    } finally {
      seed.fill(0);
    }
  });
}

function localDeviceId(publicKey: Uint8Array): string {
  const bytes = sha256(publicKey).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

async function signBounded(
  encode: (accountId: string, publicKeyWire: string) => Uint8Array,
): Promise<Uint8Array> {
  const accountId = currentAccount();
  const record = await ensureForAccount(accountId);
  const loaded = validateRecord(record);
  try {
    return signPureEd25519(loaded.seed, encode(accountId, record.publicKey));
  } finally {
    loaded.seed.fill(0);
    loaded.publicKey.fill(0);
  }
}

export const deviceIdentity = {
  async ensure(): Promise<{ publicKey: Uint8Array; deviceId: string }> {
    const accountId = currentAccount();
    const record = await ensureForAccount(accountId);
    const publicKey = decodeBase64UrlExact(record.publicKey, 32);
    return { publicKey, deviceId: localDeviceId(publicKey) };
  },

  async publicKey(): Promise<Uint8Array | null> {
    if (activeAccountId === null) return null;
    const record = await readRecord(activeAccountId);
    if (record === null) return null;
    const loaded = validateRecord(record);
    loaded.seed.fill(0);
    return loaded.publicKey;
  },

  signSignalTranscript(transcript: SignalTranscript): Promise<Uint8Array> {
    return signBounded((_accountId, publicKeyWire) => {
      if (transcript.senderRole !== "browser") {
        throw new Error("Device identity may sign only browser signal transcripts");
      }
      if (publicKeyWire === transcript.intendedPeerPublicKey) {
        throw new Error("Device identity cannot sign a signal intended for itself");
      }
      return encodeSignedSignalV2(transcript);
    });
  },

  signApproval(transcript: ApprovalTranscript): Promise<Uint8Array> {
    return signBounded((accountId, publicKeyWire) => {
      if (transcript.accountId !== accountId || transcript.browserPublicKey !== publicKeyWire) {
        throw new Error("Approval transcript does not match the active device identity");
      }
      return encodeHostPairApprovalV1(transcript);
    });
  },

  signRegistration(transcript: RegistrationTranscript): Promise<Uint8Array> {
    return signBounded((accountId, publicKeyWire) => {
      if (transcript.accountId !== accountId || transcript.browserPublicKey !== publicKeyWire) {
        throw new Error("Registration transcript does not match the active device identity");
      }
      return encodeBrowserRegistrationV1(transcript);
    });
  },

  signEndorsement(transcript: EndorsementTranscript): Promise<Uint8Array> {
    return signBounded((accountId, publicKeyWire) => {
      if (transcript.accountId !== accountId || transcript.endorserPublicKey !== publicKeyWire) {
        throw new Error("Endorsement transcript does not match the active device identity");
      }
      return encodeBrowserEndorsementV1(transcript);
    });
  },

  async reset(): Promise<void> {
    if (activeAccountId === null) return;
    const accountId = activeAccountId;
    await withLock(async () => {
      try {
        await secureStorage.delete(identityKey(accountId));
        await secureStorage.delete(deviceRegistrationStorageKey(accountId));
        for (const handler of resetHandlers) await handler(accountId);
      } catch {
        throw new DeviceIdentityError(
          "IDENTITY_STORAGE_UNAVAILABLE",
          "Device identity could not be reset completely",
        );
      }
      activeAccountId = null;
    });
  },
};
