import { describe, expect, test } from "bun:test";
import vectorsJson from "../../../proto/browser-device-registration-v1-vectors.json";
import negativeKeysJson from "../../../proto/ed25519-public-key-negative-vectors.json";
import {
  BROWSER_DEVICE_REGISTRATION_MAGIC,
  BROWSER_DEVICE_REGISTRATION_TRANSCRIPT_BYTES,
  encodeBrowserDeviceRegistrationTranscript,
  verifyBrowserDeviceRegistrationProof,
} from "./browser-device-registration-transcript";
import { encodeBase64Url } from "./signed-signal";

interface RegistrationVectors {
  contract: string;
  version: number;
  positive: {
    user_id: string;
    public_key: string;
    transcript_hex: string;
    transcript_sha256: string;
    signature: string;
  };
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

describe("browser device registration transcript", () => {
  test("matches the shared Python/TypeScript bytes, hash, and positive signature", async () => {
    const transcript = encodeBrowserDeviceRegistrationTranscript(
      vectors.positive.user_id,
      vectors.positive.public_key,
    );
    expect(new TextDecoder().decode(BROWSER_DEVICE_REGISTRATION_MAGIC)).toBe(vectors.contract);
    expect(transcript.byteLength).toBe(BROWSER_DEVICE_REGISTRATION_TRANSCRIPT_BYTES);
    expect(bytesToHex(transcript)).toBe(vectors.positive.transcript_hex);
    const transcriptBuffer = new ArrayBuffer(transcript.byteLength);
    new Uint8Array(transcriptBuffer).set(transcript);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", transcriptBuffer));
    expect(bytesToHex(hash)).toBe(vectors.positive.transcript_sha256);
    expect(
      await verifyBrowserDeviceRegistrationProof(
        vectors.positive.user_id,
        vectors.positive.public_key,
        vectors.positive.signature,
      ),
    ).toBe(true);
  });

  test("rejects every bound-field/signature mutation", async () => {
    expect(
      await verifyBrowserDeviceRegistrationProof(
        vectors.mutations.user_id,
        vectors.positive.public_key,
        vectors.positive.signature,
      ),
    ).toBe(false);
    expect(
      await verifyBrowserDeviceRegistrationProof(
        vectors.positive.user_id,
        vectors.mutations.public_key,
        vectors.positive.signature,
      ),
    ).toBe(false);
    expect(
      await verifyBrowserDeviceRegistrationProof(
        vectors.positive.user_id,
        vectors.positive.public_key,
        vectors.mutations.signature,
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
        ),
      ).rejects.toThrow();
    }
    for (const signature of vectors.malformed_signatures) {
      await expect(
        verifyBrowserDeviceRegistrationProof(
          vectors.positive.user_id,
          vectors.positive.public_key,
          signature,
        ),
      ).rejects.toThrow();
    }
  });

  test("rejects the shared noncanonical UUID text corpus before signing", () => {
    for (const userId of vectors.malformed_user_ids) {
      expect(() =>
        encodeBrowserDeviceRegistrationTranscript(userId, vectors.positive.public_key),
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
        () => encodeBrowserDeviceRegistrationTranscript(vectors.positive.user_id, invalidWire),
        `${vector.id} was accepted by the registration encoder`,
      ).toThrow("Ed25519 public key");
    }
  });

  test("accepts every shared canonical mixed-torsion key", () => {
    expect(negativeKeys.accepted_mixed_torsion_public_key_hex).toHaveLength(7);
    for (const publicKeyHex of negativeKeys.accepted_mixed_torsion_public_key_hex) {
      const publicKeyWire = encodeBase64Url(bytesFromHex(publicKeyHex));
      expect(() =>
        encodeBrowserDeviceRegistrationTranscript(vectors.positive.user_id, publicKeyWire),
      ).not.toThrow();
    }
  });
});
