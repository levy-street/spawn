import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
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

const vectors = vectorsJson;
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

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
});
