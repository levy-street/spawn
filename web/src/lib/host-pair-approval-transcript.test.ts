import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import negativeKeysJson from "../../../proto/ed25519-public-key-negative-vectors.json";
import vectorsJson from "../../../proto/host-pair-approval-v1-vectors.json";
import {
  createHostPairApprovalProof,
  loadOrCreateBrowserDeviceIdentity,
} from "./browser-device-identity";
import {
  encodeHostPairApprovalTranscript,
  HOST_PAIR_APPROVAL_MAGIC,
  HOST_PAIR_APPROVAL_TRANSCRIPT_BYTES,
  verifyHostPairApprovalProof,
} from "./host-pair-approval-transcript";
import { encodeBase64Url } from "./signed-signal";

const vectors = vectorsJson;
const negativeKeys = negativeKeysJson;
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytesFromHex = (value: string) =>
  Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );

describe("host-pair browser approval transcript", () => {
  test("matches shared Python/TypeScript bytes, hash, signature, and mutations", async () => {
    const positive = vectors.positive;
    const transcript = encodeHostPairApprovalTranscript(
      positive.user_id,
      positive.approval_nonce,
      positive.host_public_key,
      positive.browser_public_key,
    );
    expect(new TextDecoder().decode(HOST_PAIR_APPROVAL_MAGIC)).toBe(vectors.contract);
    expect(transcript.byteLength).toBe(HOST_PAIR_APPROVAL_TRANSCRIPT_BYTES);
    expect(hex(transcript)).toBe(positive.transcript_hex);
    expect(
      hex(new Uint8Array(await crypto.subtle.digest("SHA-256", transcript.slice().buffer))),
    ).toBe(positive.transcript_sha256);
    expect(
      await verifyHostPairApprovalProof(
        positive.user_id,
        positive.approval_nonce,
        positive.host_public_key,
        positive.browser_public_key,
        positive.signature,
      ),
    ).toBe(true);

    for (const [field, value] of Object.entries(vectors.mutations)) {
      const changed = { ...positive, [field]: value };
      expect(
        await verifyHostPairApprovalProof(
          changed.user_id,
          changed.approval_nonce,
          changed.host_public_key,
          changed.browser_public_key,
          changed.signature,
        ),
      ).toBe(false);
    }
  });

  test("rejects malformed nonce wires before signing", () => {
    for (const nonce of vectors.malformed_nonces) {
      expect(() =>
        encodeHostPairApprovalTranscript(
          vectors.positive.user_id,
          nonce,
          vectors.positive.host_public_key,
          vectors.positive.browser_public_key,
        ),
      ).toThrow();
    }
  });

  test("uses only the narrow WeakMap-backed proof operation", async () => {
    const accountId = vectors.positive.user_id;
    const identity = await loadOrCreateBrowserDeviceIdentity(accountId, {
      indexedDBFactory: new IDBFactory(),
    });
    const signature = await createHostPairApprovalProof(
      identity,
      accountId,
      vectors.positive.approval_nonce,
      vectors.positive.host_public_key,
    );
    expect(
      await verifyHostPairApprovalProof(
        accountId,
        vectors.positive.approval_nonce,
        vectors.positive.host_public_key,
        identity.publicKeyWire,
        signature,
      ),
    ).toBe(true);
    await expect(
      createHostPairApprovalProof(
        identity,
        vectors.mutations.user_id,
        vectors.positive.approval_nonce,
        vectors.positive.host_public_key,
      ),
    ).rejects.toThrow("does not belong");
  });

  test("rejects the complete strict key corpus in both host and browser positions", async () => {
    expect(negativeKeys.weak_public_keys).toHaveLength(8);
    expect(negativeKeys.noncanonical_public_key_hex).toHaveLength(40);
    const rejected = [
      ...negativeKeys.weak_public_keys,
      ...negativeKeys.noncanonical_public_key_hex.map((public_key_hex, index) => ({
        id: `noncanonical-${index}`,
        public_key_hex,
      })),
      ...negativeKeys.invalid_encodings,
    ];
    const positive = vectors.positive;
    const identity = await loadOrCreateBrowserDeviceIdentity(positive.user_id, {
      indexedDBFactory: new IDBFactory(),
    });

    for (const vector of rejected) {
      const invalidWire = encodeBase64Url(bytesFromHex(vector.public_key_hex));
      expect(
        () =>
          encodeHostPairApprovalTranscript(
            positive.user_id,
            positive.approval_nonce,
            invalidWire,
            positive.browser_public_key,
          ),
        `${vector.id} accepted as host key`,
      ).toThrow("Ed25519 public key");
      expect(
        () =>
          encodeHostPairApprovalTranscript(
            positive.user_id,
            positive.approval_nonce,
            positive.host_public_key,
            invalidWire,
          ),
        `${vector.id} accepted as browser key`,
      ).toThrow("Ed25519 public key");
      await expect(
        createHostPairApprovalProof(
          identity,
          positive.user_id,
          positive.approval_nonce,
          invalidWire,
        ),
        `${vector.id} host identity was signed`,
      ).rejects.toThrow("Ed25519 public key");
      await expect(
        verifyHostPairApprovalProof(
          positive.user_id,
          positive.approval_nonce,
          invalidWire,
          positive.browser_public_key,
          positive.signature,
        ),
        `${vector.id} host identity was verified`,
      ).rejects.toThrow("Ed25519 public key");
      await expect(
        verifyHostPairApprovalProof(
          positive.user_id,
          positive.approval_nonce,
          positive.host_public_key,
          invalidWire,
          positive.signature,
        ),
        `${vector.id} browser identity was verified`,
      ).rejects.toThrow("Ed25519 public key");
    }
  });
});
