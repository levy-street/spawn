import { describe, expect, test } from "bun:test";
import { encodeAcctEndorsementTranscript } from "./acct-endorsement-transcript";
import { verifyAccountEndorsementSignature } from "./approve-ceremony";
import { encodeBase64Url, exportEd25519PublicKeyWire } from "./signed-signal";

const ACCOUNT = "0b6e6c64-0000-4000-8000-000000000001";
const ENDORSED_DEVICE = "0b6e6c64-0000-4000-8000-000000000002";

async function keyPair() {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function signedEdge() {
  const endorser = await keyPair();
  const endorsed = await keyPair();
  const endorserWire = await exportEd25519PublicKeyWire(endorser.publicKey);
  const endorsedWire = await exportEd25519PublicKeyWire(endorsed.publicKey);
  const transcript = encodeAcctEndorsementTranscript(
    ACCOUNT,
    endorserWire,
    endorsedWire,
    ENDORSED_DEVICE,
  );
  const owned = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(owned).set(transcript);
  const signature = encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, endorser.privateKey, owned)),
  );
  return { endorserWire, endorsedWire, signature };
}

describe("verifyAccountEndorsementSignature", () => {
  test("accepts a genuine endorsement", async () => {
    const edge = await signedEdge();
    expect(
      await verifyAccountEndorsementSignature({
        accountId: ACCOUNT,
        endorserPublicKey: edge.endorserWire,
        endorsedPublicKey: edge.endorsedWire,
        endorsedDeviceId: ENDORSED_DEVICE,
        signature: edge.signature,
      }),
    ).toBe(true);
  });

  test("rejects a signature verified under a different endorser key", async () => {
    // The server-substitution case the reciprocal gate exists for: the edge's
    // claimed key differs from the ceremony-authenticated one the caller pins.
    const edge = await signedEdge();
    const other = await keyPair();
    expect(
      await verifyAccountEndorsementSignature({
        accountId: ACCOUNT,
        endorserPublicKey: await exportEd25519PublicKeyWire(other.publicKey),
        endorsedPublicKey: edge.endorsedWire,
        endorsedDeviceId: ENDORSED_DEVICE,
        signature: edge.signature,
      }),
    ).toBe(false);
  });

  test("rejects a transcript-field swap (wrong endorsed device id)", async () => {
    const edge = await signedEdge();
    expect(
      await verifyAccountEndorsementSignature({
        accountId: ACCOUNT,
        endorserPublicKey: edge.endorserWire,
        endorsedPublicKey: edge.endorsedWire,
        endorsedDeviceId: "0b6e6c64-0000-4000-8000-00000000dead",
        signature: edge.signature,
      }),
    ).toBe(false);
  });

  test("rejects garbage signatures without throwing", async () => {
    const edge = await signedEdge();
    expect(
      await verifyAccountEndorsementSignature({
        accountId: ACCOUNT,
        endorserPublicKey: edge.endorserWire,
        endorsedPublicKey: edge.endorsedWire,
        endorsedDeviceId: ENDORSED_DEVICE,
        signature: "not-a-signature",
      }),
    ).toBe(false);
  });
});
