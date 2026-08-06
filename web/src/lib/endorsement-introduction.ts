/**
 * The delivery leg of bidirectional device approval.
 *
 * Endorsement has always been one-directional: a trusted browser signs a
 * statement admitting a new device to a host, and the daemon verifies it. The
 * new device learned nothing from that — it still had to take the host's key
 * from the server on first contact (signed TOFU).
 *
 * But the endorsement transcript already covers the host public key. So a
 * device holding a verified endorsement holds a host key introduction signed
 * by a device the operator trusts. This module turns that into local host
 * pins: for each endorsement, re-encode the transcript from the server's
 * claims plus THIS device's own key and id, verify the signature against the
 * endorser key whose fingerprint the operator confirmed on the endorsing
 * browser's screen, and only then approve the host key locally.
 *
 * Every field the server supplies is untrusted input. Substituting the host
 * key, the endorser key, the account, or the endorsed device changes the
 * transcript, and the server cannot re-sign it — it holds no endorser private
 * key. The human check (endorser fingerprint) closes the remaining gap: a
 * server that offers an endorsement from a key the operator never confirmed
 * is refused before any signature is trusted.
 */

import { encodeBrowserEndorsementTranscript } from "./browser-endorsement-transcript";
import {
  approveBrowserHostPin,
  type BrowserHostPinStorageOptions,
  browserHostPinServerOrigin,
  resolveActiveBrowserHostPin,
} from "./browser-host-pins";
import {
  decodeEd25519PublicKeyWire,
  ed25519PublicKeyFingerprint,
  importEd25519PublicKey,
} from "./signed-signal";

/** One endorsement as served. Every field is untrusted until verified. */
export interface ClaimedEndorsement {
  readonly host_id: string;
  readonly host_name: string;
  readonly host_public_key: string;
  readonly endorser_device_id: string;
  readonly endorser_public_key: string;
  readonly endorser_label?: string | null;
  readonly signature: string;
}

export interface EndorsementIntroduction {
  readonly hostId: string;
  readonly hostName: string;
  readonly hostPublicKey: string;
  readonly hostFingerprint: string;
  readonly endorserDeviceId: string;
  readonly endorserPublicKey: string;
  readonly endorserLabel: string | null;
  /** Locally derived from the endorser key — this is what the human confirms. */
  readonly endorserFingerprint: string;
}

export interface VerifyIntroductionsInput {
  readonly accountId: string;
  /** This device's own identity — the endorsed party in every transcript. */
  readonly deviceId: string;
  readonly devicePublicKeyWire: string;
  readonly claimed: readonly ClaimedEndorsement[];
}

/**
 * Verify each endorsement's signature and return only those that hold.
 *
 * Signature verification alone does not authorize anything: it proves the
 * holder of `endorser_public_key` vouched for this exact (account, host key,
 * this device) tuple. The caller must still have the operator confirm each
 * `endorserFingerprint` before calling {@link acceptEndorsementIntroductions}.
 */
export async function verifyEndorsementIntroductions(
  input: VerifyIntroductionsInput,
): Promise<EndorsementIntroduction[]> {
  const verified: EndorsementIntroduction[] = [];
  for (const claim of input.claimed) {
    let transcript: Uint8Array;
    let endorserKey: CryptoKey;
    let signature: Uint8Array;
    try {
      transcript = encodeBrowserEndorsementTranscript(
        input.accountId,
        claim.host_public_key,
        claim.endorser_public_key,
        input.devicePublicKeyWire,
        input.deviceId,
      );
      endorserKey = await importEd25519PublicKey(
        decodeEd25519PublicKeyWire(claim.endorser_public_key),
      );
      signature = decodeEndorsementSignature(claim.signature);
    } catch {
      // Malformed claim: not an endorsement at all.
      continue;
    }
    const ownedTranscript = new ArrayBuffer(transcript.byteLength);
    new Uint8Array(ownedTranscript).set(transcript);
    const ownedSignature = new ArrayBuffer(signature.byteLength);
    new Uint8Array(ownedSignature).set(signature);
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      endorserKey,
      ownedSignature,
      ownedTranscript,
    );
    if (!ok) continue;
    verified.push({
      hostId: claim.host_id,
      hostName: claim.host_name,
      hostPublicKey: claim.host_public_key,
      hostFingerprint: await ed25519PublicKeyFingerprint(claim.host_public_key),
      endorserDeviceId: claim.endorser_device_id,
      endorserPublicKey: claim.endorser_public_key,
      endorserLabel: claim.endorser_label ?? null,
      endorserFingerprint: await ed25519PublicKeyFingerprint(claim.endorser_public_key),
    });
  }
  return verified;
}

export interface AcceptIntroductionsResult {
  readonly approved: number;
  readonly failures: readonly string[];
}

/**
 * Approve the introduced host keys locally, binding each host id.
 *
 * Call only with introductions whose endorser fingerprint the operator has
 * confirmed. Approval is the same local ceremony a terminal pairing performs,
 * so a host introduced here is thereafter fully verified — a later key
 * substitution is refused, exactly as for a hand-paired host.
 */
export async function acceptEndorsementIntroductions(
  accountId: string,
  introductions: readonly EndorsementIntroduction[],
  storage: BrowserHostPinStorageOptions = {},
  /** Test-only override; defaults to this page's pin-scoping origin. */
  originOverride?: string,
): Promise<AcceptIntroductionsResult> {
  const origin = originOverride ?? browserHostPinServerOrigin();
  let approved = 0;
  const failures: string[] = [];
  for (const introduction of introductions) {
    try {
      await approveBrowserHostPin(
        {
          accountId,
          origin,
          hostPublicKey: introduction.hostPublicKey,
          hostFingerprint: introduction.hostFingerprint,
        },
        storage,
      );
      // Bind the host id to the freshly approved key, so the downgrade gate
      // sees this host as pinned from the first connection onward.
      await resolveActiveBrowserHostPin(
        {
          accountId,
          origin,
          hostId: introduction.hostId,
          claimedHostPublicKey: introduction.hostPublicKey,
          claimedHostFingerprint: introduction.hostFingerprint,
        },
        storage,
      );
      approved += 1;
    } catch (cause) {
      failures.push(
        `${introduction.hostName}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return { approved, failures };
}

function decodeEndorsementSignature(wire: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{86}$/u.test(wire)) {
    throw new Error("endorsement signature is not 86 base64url characters");
  }
  const padded = wire.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded);
  if (binary.length !== 64) throw new Error("endorsement signature has the wrong length");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
