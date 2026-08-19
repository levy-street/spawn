import { describe, expect, test } from "bun:test";
import {
  ACCT_ENDORSEMENT_TRANSCRIPT_BYTES,
  encodeAcctEndorsementTranscript,
} from "./acct-endorsement-transcript";
import { encodeBase64Url } from "./signed-signal";

// Produced by daemon/src/acct_endorsement.rs and spawn_server/acct_endorsement.py.
// The daemon verifies what this file signs, so a divergence here breaks account
// endorsement across runtimes without either side noticing -- each would still
// agree with itself. Same endorser/endorsed keys as the per-host vector; the
// host field is gone (that removal IS the per-host -> account-scoped change).
const VECTOR = {
  accountId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  deviceId: "11111111-2222-4333-8444-555555555555",
  endorser: "C1E62bSSQBXKCQLtB5BE06xdvsIwbwaUjBDajrbjny0",
  endorsed: "kaKKC3Q4FZOk2UaVeSCJJq_IrYLIg5t2RDWbnrqaSzo",
  sha256: "7HXf12SEyR3WDpy4EeHKVQCsffmdTnMgMVPbq9jgnq8",
};

describe("account endorsement transcript", () => {
  test("matches the daemon's bytes exactly", async () => {
    const transcript = encodeAcctEndorsementTranscript(
      VECTOR.accountId,
      VECTOR.endorser,
      VECTOR.endorsed,
      VECTOR.deviceId,
    );
    expect(transcript.byteLength).toBe(ACCT_ENDORSEMENT_TRANSCRIPT_BYTES);
    expect(ACCT_ENDORSEMENT_TRANSCRIPT_BYTES).toBe(118);
    const owned = new ArrayBuffer(transcript.byteLength);
    new Uint8Array(owned).set(transcript);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
    expect(encodeBase64Url(digest)).toBe(VECTOR.sha256);
  });

  test("refuses a self-endorsement", () => {
    expect(() =>
      encodeAcctEndorsementTranscript(
        VECTOR.accountId,
        VECTOR.endorser,
        VECTOR.endorser,
        VECTOR.deviceId,
      ),
    ).toThrow();
  });

  test("refuses non-canonical identifiers", () => {
    for (const bad of ["NOT-A-UUID", "", VECTOR.accountId.toUpperCase()]) {
      expect(() =>
        encodeAcctEndorsementTranscript(bad, VECTOR.endorser, VECTOR.endorsed, VECTOR.deviceId),
      ).toThrow();
    }
  });

  test("every field is bound: changing any one changes the bytes", () => {
    const base = encodeAcctEndorsementTranscript(
      VECTOR.accountId,
      VECTOR.endorser,
      VECTOR.endorsed,
      VECTOR.deviceId,
    );
    const repointedDevice = encodeAcctEndorsementTranscript(
      VECTOR.accountId,
      VECTOR.endorser,
      VECTOR.endorsed,
      "22222222-3333-4444-8555-666666666666",
    );
    const otherAccount = encodeAcctEndorsementTranscript(
      "00000000-0000-4000-8000-000000000000",
      VECTOR.endorser,
      VECTOR.endorsed,
      VECTOR.deviceId,
    );
    expect(encodeBase64Url(repointedDevice)).not.toBe(encodeBase64Url(base));
    expect(encodeBase64Url(otherAccount)).not.toBe(encodeBase64Url(base));
  });
});
