import { describe, expect, test } from "bun:test";
import vectorsJson from "../../../proto/browser-device-registration-v1-vectors.json";
import {
  BROWSER_DEVICE_REGISTRATION_MAGIC,
  BROWSER_DEVICE_REGISTRATION_TRANSCRIPT_BYTES,
  encodeBrowserDeviceRegistrationTranscript,
  verifyBrowserDeviceRegistrationProof,
} from "./browser-device-registration-transcript";

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

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
});
