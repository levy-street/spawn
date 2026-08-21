/**
 * Host-key gossip over the add-device ceremony (docs/TRUST_DEVICE_MESH.md R7).
 *
 * P1 makes every host ACCEPT a new device, but acceptance is not discovery: the
 * new device still had to take each host's key from the server on first contact
 * (signed TOFU). The ceremony already authenticates both devices' identity keys
 * to each other — the committed SAS pins the exact bytes the human's number
 * covered — so anything the approver signs and the joiner verifies against that
 * PINNED key inherits the ceremony's authentication. This module rides host-key
 * introductions on it: the approver signs, per host it has itself verified out
 * of band, a statement naming the host key and the specific joiner; the joiner
 * verifies each against the ceremony-pinned approver key and only then approves
 * the host key locally, exactly as a hand-run possession would.
 *
 * The transcript is domain-separated (SPAWN-HOST-INTRO-V1) and deliberately NOT
 * `SPAWN-BROWSER-ENDORSE-V1`: that statement doubles as daemon pin adoption, and
 * a signature must never be replayable across protocols. Nothing here touches
 * the daemon — both ends are browsers, and the server relays bytes it cannot
 * forge (it holds no device private key; substituting any field changes the
 * transcript and kills the signature).
 *
 * Binding the JOINER key into the transcript stops replay: an introduction
 * minted for one ceremony verifies for no other device.
 */

import {
  decodeBase64Url,
  decodeEd25519PublicKeyWire,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  ed25519PublicKeyFingerprint,
  encodeBase64Url,
  importEd25519PublicKeyWire,
} from "./signed-signal";

const textEncoder = new TextEncoder();

export const HOST_INTRO_MAGIC = textEncoder.encode("SPAWN-HOST-INTRO-V1");
export const HOST_INTRO_VERSION = 1;
const UUID_BYTES = 16;

export const HOST_INTRO_TRANSCRIPT_BYTES =
  HOST_INTRO_MAGIC.byteLength + 1 + UUID_BYTES + ED25519_PUBLIC_KEY_BYTES * 3;

/** Most accounts hold a handful of hosts; the relay caps the list server-side. */
export const MAX_HOST_INTRODUCTIONS = 64;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function uuidBytes(value: string, field: string): Uint8Array {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${field} must be a canonical lowercase UUID`);
  }
  const hex = value.replaceAll("-", "");
  return Uint8Array.from({ length: UUID_BYTES }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

/**
 * `magic ‖ version ‖ account ‖ introducer_pk ‖ host_pk ‖ joiner_pk`.
 *
 * The introducer key is in the bytes (the signer names itself), the host key is
 * the payload, and the joiner key scopes the statement to one ceremony.
 */
export function encodeHostIntroductionTranscript(
  accountId: string,
  introducerPublicKeyWire: string,
  hostPublicKeyWire: string,
  joinerPublicKeyWire: string,
): Uint8Array {
  const introducerPublicKey = decodeEd25519PublicKeyWire(introducerPublicKeyWire);
  const hostPublicKey = decodeEd25519PublicKeyWire(hostPublicKeyWire);
  const joinerPublicKey = decodeEd25519PublicKeyWire(joinerPublicKeyWire);
  if (encodeBase64Url(introducerPublicKey) === encodeBase64Url(joinerPublicKey)) {
    // A device introducing hosts to itself is the vacuous statement TOFU already is.
    throw new Error("a device may not introduce hosts to itself");
  }

  const output = new Uint8Array(HOST_INTRO_TRANSCRIPT_BYTES);
  let offset = 0;
  for (const field of [
    HOST_INTRO_MAGIC,
    Uint8Array.of(HOST_INTRO_VERSION),
    uuidBytes(accountId, "account id"),
    introducerPublicKey,
    hostPublicKey,
    joinerPublicKey,
  ]) {
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
}

/** One introduction as relayed. Every field is untrusted until verified. */
export interface ClaimedHostIntroduction {
  readonly host_id: string;
  readonly host_name: string;
  readonly host_public_key: string;
  readonly signature: string;
}

export interface AcceptedHostIntroduction {
  readonly hostId: string;
  readonly hostName: string;
  readonly hostPublicKey: string;
  /** Derived locally from the verified key — never the server's claim. */
  readonly hostFingerprint: string;
}

export interface HostIntroductionAcceptancePlan {
  readonly accepted: readonly AcceptedHostIntroduction[];
  /** Human-readable reasons, for a non-fatal surface; nothing was trusted. */
  readonly rejected: readonly string[];
}

/**
 * JOINER side: decide which relayed introductions are real. Each signature is
 * verified against the CEREMONY-PINNED approver key and this device's own key —
 * the two values the human's number authenticated — never against anything the
 * relay row currently claims. A failed verification rejects that introduction
 * and trusts nothing.
 */
export async function planHostIntroductionAcceptance(input: {
  accountId: string;
  /** The approver key pinned at SAS-compute time (approve-ceremony.ts). */
  pinnedIntroducerPublicKey: string;
  /** This device's own identity key (also pinned by the ceremony). */
  ownPublicKey: string;
  claimed: readonly ClaimedHostIntroduction[];
}): Promise<HostIntroductionAcceptancePlan> {
  const accepted: AcceptedHostIntroduction[] = [];
  const rejected: string[] = [];
  for (const item of input.claimed.slice(0, MAX_HOST_INTRODUCTIONS)) {
    const name = typeof item.host_name === "string" && item.host_name ? item.host_name : "a host";
    try {
      const transcript = encodeHostIntroductionTranscript(
        input.accountId,
        input.pinnedIntroducerPublicKey,
        item.host_public_key,
        input.ownPublicKey,
      );
      const ownedTranscript = new ArrayBuffer(transcript.byteLength);
      new Uint8Array(ownedTranscript).set(transcript);
      const signature = decodeBase64Url(item.signature, ED25519_SIGNATURE_BYTES);
      const ownedSignature = new ArrayBuffer(signature.byteLength);
      new Uint8Array(ownedSignature).set(signature);
      const key = await importEd25519PublicKeyWire(input.pinnedIntroducerPublicKey);
      const valid = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        ownedSignature,
        ownedTranscript,
      );
      if (!valid) {
        rejected.push(`${name}: the introduction did not verify`);
        continue;
      }
      accepted.push({
        hostId: item.host_id,
        hostName: name,
        hostPublicKey: item.host_public_key,
        hostFingerprint: await ed25519PublicKeyFingerprint(item.host_public_key),
      });
    } catch (cause) {
      rejected.push(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { accepted, rejected };
}
