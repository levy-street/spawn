import { describe, expect, test } from "bun:test";
import {
  createRootEndorsementProof,
  exportAccountRootMaterial,
  generateAccountRoot,
  importAccountRoot,
} from "./account-root";
import { encodeAcctEndorsementTranscript } from "./acct-endorsement-transcript";
import { decodeEd25519PublicKeyWire } from "./signed-signal";

const ACCOUNT = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const DEVICE = "11111111-2222-4333-8444-555555555555";
const DEVICE_KEY = "kaKKC3Q4FZOk2UaVeSCJJq_IrYLIg5t2RDWbnrqaSzo"; // seed-13 device key vector

async function verifyRootEndorsement(
  rootPublicKeyWire: string,
  endorsedPublicKeyWire: string,
  endorsedDeviceId: string,
  signatureWire: string,
): Promise<boolean> {
  const transcript = encodeAcctEndorsementTranscript(
    ACCOUNT,
    rootPublicKeyWire,
    endorsedPublicKeyWire,
    endorsedDeviceId,
  );
  const owned = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(owned).set(transcript);
  const rawKey = decodeEd25519PublicKeyWire(rootPublicKeyWire);
  const keyBuf = new ArrayBuffer(rawKey.byteLength);
  new Uint8Array(keyBuf).set(rawKey);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const sigBytes = Uint8Array.from(atob(signatureWire.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  const sigBuf = new ArrayBuffer(sigBytes.byteLength);
  new Uint8Array(sigBuf).set(sigBytes);
  return crypto.subtle.verify({ name: "Ed25519" }, publicKey, sigBuf, owned);
}

describe("account root", () => {
  test("a minted root signs a verifiable root endorsement R→d", async () => {
    const root = await generateAccountRoot();
    const sig = await createRootEndorsementProof(root, ACCOUNT, DEVICE_KEY, DEVICE);
    expect(await verifyRootEndorsement(root.publicKeyWire, DEVICE_KEY, DEVICE, sig)).toBe(true);
  });

  test("root material round-trips: sealed seed reconstructs a signing root", async () => {
    const root = await generateAccountRoot();
    const material = await exportAccountRootMaterial(root);
    expect(material.publicKeyWire).toBe(root.publicKeyWire);
    // Reconstruct from the sealed material (as a passkey unlock would) and sign.
    const restored = await importAccountRoot(material);
    expect(restored.publicKeyWire).toBe(root.publicKeyWire);
    const sig = await createRootEndorsementProof(restored, ACCOUNT, DEVICE_KEY, DEVICE);
    expect(await verifyRootEndorsement(root.publicKeyWire, DEVICE_KEY, DEVICE, sig)).toBe(true);
  });

  test("an endorsement is bound to the root — another key's signature fails", async () => {
    const root = await generateAccountRoot();
    const impostor = await generateAccountRoot();
    const sig = await createRootEndorsementProof(impostor, ACCOUNT, DEVICE_KEY, DEVICE);
    // Signed by the impostor, presented as the real root: must not verify.
    expect(await verifyRootEndorsement(root.publicKeyWire, DEVICE_KEY, DEVICE, sig)).toBe(false);
  });

  test("the root cannot endorse itself (transcript self-endorsement guard)", async () => {
    const root = await generateAccountRoot();
    await expect(
      createRootEndorsementProof(root, ACCOUNT, root.publicKeyWire, DEVICE),
    ).rejects.toThrow();
  });
});
