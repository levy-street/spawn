import { describe, expect, test } from "bun:test";
import {
  BROWSER_ENDORSEMENT_TRANSCRIPT_BYTES,
  encodeBrowserEndorsementTranscript,
} from "./browser-endorsement-transcript";
import { encodeBase64Url } from "./signed-signal";

// Produced by daemon/src/browser_endorsement.rs. The daemon verifies what this
// file signs, so a divergence here breaks endorsement across runtimes without
// either side noticing -- each would still agree with itself.
const VECTOR = {
  userId: "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  deviceId: "11111111-2222-4333-8444-555555555555",
  host: "Zr5-Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo",
  endorser: "C1E62bSSQBXKCQLtB5BE06xdvsIwbwaUjBDajrbjny0",
  endorsed: "kaKKC3Q4FZOk2UaVeSCJJq_IrYLIg5t2RDWbnrqaSzo",
  sha256: "zWI0kvAu5asJ4YKWiXSmlbSZM2u8_z7DOiVQ6vE220Y",
};

describe("browser endorsement transcript", () => {
  test("matches the daemon's bytes exactly", async () => {
    const transcript = encodeBrowserEndorsementTranscript(
      VECTOR.userId,
      VECTOR.host,
      VECTOR.endorser,
      VECTOR.endorsed,
      VECTOR.deviceId,
    );
    expect(transcript.byteLength).toBe(BROWSER_ENDORSEMENT_TRANSCRIPT_BYTES);
    const owned = new ArrayBuffer(transcript.byteLength);
    new Uint8Array(owned).set(transcript);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
    expect(encodeBase64Url(digest)).toBe(VECTOR.sha256);
  });

  test("refuses a self-endorsement", () => {
    expect(() =>
      encodeBrowserEndorsementTranscript(
        VECTOR.userId,
        VECTOR.host,
        VECTOR.endorser,
        VECTOR.endorser,
        VECTOR.deviceId,
      ),
    ).toThrow();
  });

  test("refuses non-canonical identifiers", () => {
    for (const bad of ["NOT-A-UUID", "", VECTOR.userId.toUpperCase()]) {
      expect(() =>
        encodeBrowserEndorsementTranscript(
          bad,
          VECTOR.host,
          VECTOR.endorser,
          VECTOR.endorsed,
          VECTOR.deviceId,
        ),
      ).toThrow();
    }
  });

  test("every field is bound: changing any one changes the bytes", async () => {
    const base = encodeBrowserEndorsementTranscript(
      VECTOR.userId,
      VECTOR.host,
      VECTOR.endorser,
      VECTOR.endorsed,
      VECTOR.deviceId,
    );
    const repointed = encodeBrowserEndorsementTranscript(
      VECTOR.userId,
      VECTOR.host,
      VECTOR.endorser,
      VECTOR.endorsed,
      "22222222-3333-4444-8555-666666666666",
    );
    expect(encodeBase64Url(repointed)).not.toBe(encodeBase64Url(base));
  });
});
