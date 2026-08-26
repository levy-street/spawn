import { describe, expect, test } from "bun:test";
import {
  ceremonySas,
  commitWire,
  freshSasNonce,
  SAS_NONCE_BYTES,
  verifyCommitWire,
} from "./add-device-ceremony";
import { b64urlEncode } from "./sas";

// The shared SAS algorithm (daemon/src/sas.rs, web/src/lib/sas.ts) produces
// "449 728" (six digits) for these vectors. The device↔device ceremony uses the
// same algorithm truncated to FOUR digits — the last four of the six-digit
// value, ungrouped: 449728 % 10000 = 9728 -> "9728".
const KEY_I = b64urlEncode(new Uint8Array(32).fill(1));
const KEY_J = b64urlEncode(new Uint8Array(32).fill(2));
const NONCE_I = b64urlEncode(new Uint8Array(32).fill(3));
const NONCE_J = b64urlEncode(new Uint8Array(32).fill(4));

describe("add-device ceremony SAS", () => {
  test("derives the four-digit device number from the shared SAS vector", async () => {
    expect(await ceremonySas(KEY_I, KEY_J, NONCE_I, NONCE_J)).toBe("9728");
  });

  test("a matching revealed nonce opens the commitment", async () => {
    const commitment = await commitWire(KEY_I, new Uint8Array(32).fill(3));
    expect(await verifyCommitWire(commitment, KEY_I, NONCE_I)).toBe(true);
  });

  test("a mismatched revealed nonce is rejected (substitution attempt)", async () => {
    const commitment = await commitWire(KEY_I, new Uint8Array(32).fill(3));
    const tampered = b64urlEncode(new Uint8Array(32).fill(9));
    expect(await verifyCommitWire(commitment, KEY_I, tampered)).toBe(false);
  });

  test("both sides derive the same number from the relayed values", async () => {
    // Simulate the relay carrying each side's contribution to the other.
    const nI = freshSasNonce();
    const nJ = freshSasNonce();
    expect(nI.byteLength).toBe(SAS_NONCE_BYTES);
    const nIWire = b64urlEncode(nI);
    const nJWire = b64urlEncode(nJ);

    const initiatorNumber = await ceremonySas(KEY_I, KEY_J, nIWire, nJWire);
    const joinerNumber = await ceremonySas(KEY_I, KEY_J, nIWire, nJWire);
    expect(initiatorNumber).toBe(joinerNumber);
    expect(initiatorNumber).toMatch(/^\d{4}$/);
  });
});
