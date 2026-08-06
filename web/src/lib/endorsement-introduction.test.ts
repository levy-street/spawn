import { beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { loadOrCreateBrowserDeviceIdentity } from "./browser-device-identity";
import { encodeBrowserEndorsementTranscript } from "./browser-endorsement-transcript";
import { listActiveBrowserHostPins, resolveActiveBrowserHostPin } from "./browser-host-pins";
import {
  acceptEndorsementIntroductions,
  type ClaimedEndorsement,
  verifyEndorsementIntroductions,
} from "./endorsement-introduction";
import { ed25519PublicKeyFingerprint, encodeBase64Url } from "./signed-signal";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const HOST_ID = "00000000-0000-4000-8000-000000000003";
const DEVICE_ID = "00000000-0000-4000-8000-000000000007";
const ORIGIN = "https://spawn.example";

let pinFactory: IDBFactory;
let deviceFactory: IDBFactory;

/** An Ed25519 keypair whose raw public bytes we can hand around as wire. */
async function keypair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, wire: encodeBase64Url(raw) };
}

async function signEndorsement(
  privateKey: CryptoKey,
  hostPublicKey: string,
  endorserPublicKey: string,
  endorsedPublicKey: string,
  endorsedDeviceId = DEVICE_ID,
  accountId = ACCOUNT,
): Promise<string> {
  const transcript = encodeBrowserEndorsementTranscript(
    accountId,
    hostPublicKey,
    endorserPublicKey,
    endorsedPublicKey,
    endorsedDeviceId,
  );
  const owned = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(owned).set(transcript);
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, owned)),
  );
}

beforeEach(() => {
  pinFactory = new IDBFactory();
  deviceFactory = new IDBFactory();
});

describe("endorsement introductions", () => {
  test("a valid endorsement introduces its host key and becomes a real pin", async () => {
    const identity = await loadOrCreateBrowserDeviceIdentity(ACCOUNT, {
      indexedDBFactory: deviceFactory,
    });
    const host = await keypair();
    const endorser = await keypair();
    const claimed: ClaimedEndorsement = {
      host_id: HOST_ID,
      host_name: "dream",
      host_public_key: host.wire,
      endorser_device_id: "00000000-0000-4000-8000-000000000009",
      endorser_public_key: endorser.wire,
      endorser_label: "Chrome on Mac",
      signature: await signEndorsement(
        endorser.pair.privateKey,
        host.wire,
        endorser.wire,
        identity.publicKeyWire,
      ),
    };

    const verified = await verifyEndorsementIntroductions({
      accountId: ACCOUNT,
      deviceId: DEVICE_ID,
      devicePublicKeyWire: identity.publicKeyWire,
      claimed: [claimed],
    });
    expect(verified).toHaveLength(1);
    expect(verified[0].hostPublicKey).toBe(host.wire);
    // The fingerprint the operator confirms is derived locally from the key.
    expect(verified[0].endorserFingerprint).toBe(await ed25519PublicKeyFingerprint(endorser.wire));

    const storage = { indexedDBFactory: pinFactory, now: () => 1_000 } as const;
    const result = await acceptEndorsementIntroductions(ACCOUNT, verified, storage, ORIGIN);
    expect(result).toMatchObject({ approved: 1, failures: [] });

    // The host is now genuinely pinned: resolving it returns the approved key,
    // so the connection is verified rather than first-contact.
    const resolved = await resolveActiveBrowserHostPin(
      {
        accountId: ACCOUNT,
        origin: ORIGIN,
        hostId: HOST_ID,
        claimedHostPublicKey: host.wire,
        claimedHostFingerprint: await ed25519PublicKeyFingerprint(host.wire),
      },
      storage,
    );
    expect(resolved).toBe(host.wire);
    expect(
      await listActiveBrowserHostPins({ accountId: ACCOUNT, origin: ORIGIN }, storage),
    ).toHaveLength(1);
  });

  test("a substituted host key breaks the signature and introduces nothing", async () => {
    const identity = await loadOrCreateBrowserDeviceIdentity(ACCOUNT, {
      indexedDBFactory: deviceFactory,
    });
    const host = await keypair();
    const attacker = await keypair();
    const endorser = await keypair();
    // Signed for the real host, then served with the attacker's key swapped in.
    const signature = await signEndorsement(
      endorser.pair.privateKey,
      host.wire,
      endorser.wire,
      identity.publicKeyWire,
    );
    const verified = await verifyEndorsementIntroductions({
      accountId: ACCOUNT,
      deviceId: DEVICE_ID,
      devicePublicKeyWire: identity.publicKeyWire,
      claimed: [
        {
          host_id: HOST_ID,
          host_name: "dream",
          host_public_key: attacker.wire,
          endorser_device_id: "00000000-0000-4000-8000-000000000009",
          endorser_public_key: endorser.wire,
          signature,
        },
      ],
    });
    expect(verified).toEqual([]);
  });

  test("an endorsement for a different device is not usable by this one", async () => {
    const identity = await loadOrCreateBrowserDeviceIdentity(ACCOUNT, {
      indexedDBFactory: deviceFactory,
    });
    const other = await keypair();
    const host = await keypair();
    const endorser = await keypair();
    // A real endorsement — of somebody else's key.
    const signature = await signEndorsement(
      endorser.pair.privateKey,
      host.wire,
      endorser.wire,
      other.wire,
    );
    const verified = await verifyEndorsementIntroductions({
      accountId: ACCOUNT,
      deviceId: DEVICE_ID,
      devicePublicKeyWire: identity.publicKeyWire,
      claimed: [
        {
          host_id: HOST_ID,
          host_name: "dream",
          host_public_key: host.wire,
          endorser_device_id: "00000000-0000-4000-8000-000000000009",
          endorser_public_key: endorser.wire,
          signature,
        },
      ],
    });
    expect(verified).toEqual([]);
  });

  test("a self-signed introduction is refused (no bootstrapping own trust)", async () => {
    const identity = await loadOrCreateBrowserDeviceIdentity(ACCOUNT, {
      indexedDBFactory: deviceFactory,
    });
    const host = await keypair();
    // Even a perfectly formed signature cannot help: the transcript encoder
    // refuses endorser == endorsed, so this claim never verifies.
    const verified = await verifyEndorsementIntroductions({
      accountId: ACCOUNT,
      deviceId: DEVICE_ID,
      devicePublicKeyWire: identity.publicKeyWire,
      claimed: [
        {
          host_id: HOST_ID,
          host_name: "dream",
          host_public_key: host.wire,
          endorser_device_id: DEVICE_ID,
          endorser_public_key: identity.publicKeyWire,
          signature: "A".repeat(86),
        },
      ],
    });
    expect(verified).toEqual([]);
  });

  test("malformed claims are skipped without failing the whole batch", async () => {
    const identity = await loadOrCreateBrowserDeviceIdentity(ACCOUNT, {
      indexedDBFactory: deviceFactory,
    });
    const host = await keypair();
    const endorser = await keypair();
    const good: ClaimedEndorsement = {
      host_id: HOST_ID,
      host_name: "dream",
      host_public_key: host.wire,
      endorser_device_id: "00000000-0000-4000-8000-000000000009",
      endorser_public_key: endorser.wire,
      signature: await signEndorsement(
        endorser.pair.privateKey,
        host.wire,
        endorser.wire,
        identity.publicKeyWire,
      ),
    };
    const verified = await verifyEndorsementIntroductions({
      accountId: ACCOUNT,
      deviceId: DEVICE_ID,
      devicePublicKeyWire: identity.publicKeyWire,
      claimed: [
        { ...good, signature: "not-a-signature" },
        { ...good, host_public_key: "@@@" },
        good,
      ],
    });
    expect(verified).toHaveLength(1);
    expect(verified[0].hostPublicKey).toBe(host.wire);
  });
});
