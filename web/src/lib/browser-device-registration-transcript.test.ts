import { describe, expect, test } from "bun:test";
import vectorsJson from "../../../proto/browser-device-registration-v2-vectors.json";
import negativeKeysJson from "../../../proto/ed25519-public-key-negative-vectors.json";
import {
  BROWSER_DEVICE_REGISTRATION_MAGIC,
  BROWSER_DEVICE_REGISTRATION_TRANSCRIPT_BYTES,
  encodeBrowserDeviceRegistrationTranscript,
  verifyBrowserDeviceRegistrationProof,
} from "./browser-device-registration-transcript";
import { encodeBase64Url } from "./signed-signal";

interface PositiveVector {
  user_id: string;
  public_key: string;
  is_root: boolean;
  transcript_hex: string;
  transcript_sha256: string;
  signature: string;
}

interface RegistrationVectors {
  contract: string;
  version: number;
  positive: PositiveVector;
  positive_root: PositiveVector;
  mutations: { user_id: string; public_key: string; signature: string };
  malformed_user_ids: string[];
  malformed_public_keys: string[];
  malformed_signatures: string[];
}

const vectors = vectorsJson as RegistrationVectors;
const negativeKeys = negativeKeysJson;

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

async function assertPositive(positive: PositiveVector): Promise<void> {
  const transcript = encodeBrowserDeviceRegistrationTranscript(
    positive.user_id,
    positive.public_key,
    positive.is_root,
  );
  expect(transcript.byteLength).toBe(BROWSER_DEVICE_REGISTRATION_TRANSCRIPT_BYTES);
  expect(bytesToHex(transcript)).toBe(positive.transcript_hex);
  const transcriptBuffer = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(transcriptBuffer).set(transcript);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", transcriptBuffer));
  expect(bytesToHex(hash)).toBe(positive.transcript_sha256);
  expect(
    await verifyBrowserDeviceRegistrationProof(
      positive.user_id,
      positive.public_key,
      positive.signature,
      positive.is_root,
    ),
  ).toBe(true);
}

describe("browser device registration transcript", () => {
  test("matches the shared Python/TypeScript bytes, hash, and positive signatures", async () => {
    expect(new TextDecoder().decode(BROWSER_DEVICE_REGISTRATION_MAGIC)).toBe(vectors.contract);
    expect(vectors.positive.is_root).toBe(false);
    expect(vectors.positive_root.is_root).toBe(true);
    await assertPositive(vectors.positive);
    await assertPositive(vectors.positive_root);
  });

  test("rejects every bound-field/signature mutation", async () => {
    expect(
      await verifyBrowserDeviceRegistrationProof(
        vectors.mutations.user_id,
        vectors.positive.public_key,
        vectors.positive.signature,
        vectors.positive.is_root,
      ),
    ).toBe(false);
    expect(
      await verifyBrowserDeviceRegistrationProof(
        vectors.positive.user_id,
        vectors.mutations.public_key,
        vectors.positive.signature,
        vectors.positive.is_root,
      ),
    ).toBe(false);
    expect(
      await verifyBrowserDeviceRegistrationProof(
        vectors.positive.user_id,
        vectors.positive.public_key,
        vectors.mutations.signature,
        vectors.positive.is_root,
      ),
    ).toBe(false);
  });

  test("a flipped root flag breaks the proof in both directions (B1)", async () => {
    // A device proof cannot be replayed to claim root authority...
    expect(
      await verifyBrowserDeviceRegistrationProof(
        vectors.positive.user_id,
        vectors.positive.public_key,
        vectors.positive.signature,
        true,
      ),
    ).toBe(false);
    // ...and a root proof cannot demote/launder into an ordinary device row.
    expect(
      await verifyBrowserDeviceRegistrationProof(
        vectors.positive_root.user_id,
        vectors.positive_root.public_key,
        vectors.positive_root.signature,
        false,
      ),
    ).toBe(false);
  });

  test("rejects malformed fixed-width key and signature wires", async () => {
    for (const publicKey of vectors.malformed_public_keys) {
      await expect(
        verifyBrowserDeviceRegistrationProof(
          vectors.positive.user_id,
          publicKey,
          vectors.positive.signature,
          vectors.positive.is_root,
        ),
      ).rejects.toThrow();
    }
    for (const signature of vectors.malformed_signatures) {
      await expect(
        verifyBrowserDeviceRegistrationProof(
          vectors.positive.user_id,
          vectors.positive.public_key,
          signature,
          vectors.positive.is_root,
        ),
      ).rejects.toThrow();
    }
  });

  test("rejects the shared noncanonical UUID text corpus before signing", () => {
    for (const userId of vectors.malformed_user_ids) {
      expect(() =>
        encodeBrowserDeviceRegistrationTranscript(userId, vectors.positive.public_key, false),
      ).toThrow("canonical lowercase UUID");
    }
  });

  test("rejects the complete shared strict public-key corpus before signing", () => {
    expect(negativeKeys.weak_public_keys).toHaveLength(8);
    expect(negativeKeys.noncanonical_public_key_hex).toHaveLength(40);
    expect(negativeKeys.invalid_encodings.length).toBeGreaterThanOrEqual(1);
    const rejected = [
      ...negativeKeys.weak_public_keys,
      ...negativeKeys.noncanonical_public_key_hex.map((public_key_hex, index) => ({
        id: `noncanonical-${index}`,
        public_key_hex,
      })),
      ...negativeKeys.invalid_encodings,
    ];

    for (const vector of rejected) {
      const invalidWire = encodeBase64Url(bytesFromHex(vector.public_key_hex));
      expect(
        () =>
          encodeBrowserDeviceRegistrationTranscript(vectors.positive.user_id, invalidWire, false),
        `${vector.id} was accepted by the registration encoder`,
      ).toThrow("Ed25519 public key");
    }
  });

  test("accepts every shared canonical mixed-torsion key", () => {
    expect(negativeKeys.accepted_mixed_torsion_public_key_hex).toHaveLength(7);
    for (const publicKeyHex of negativeKeys.accepted_mixed_torsion_public_key_hex) {
      const publicKeyWire = encodeBase64Url(bytesFromHex(publicKeyHex));
      expect(() =>
        encodeBrowserDeviceRegistrationTranscript(vectors.positive.user_id, publicKeyWire, false),
      ).not.toThrow();
    }
  });
});
