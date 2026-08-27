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

// ---------------------------------------------------------------------------
// Continuous gossip (docs/TRUST_DEVICE_MESH.md R7, continuous leg)
// ---------------------------------------------------------------------------

export const HOST_INTRO_BCAST_MAGIC = textEncoder.encode("SPAWN-HOST-INTRO-BCAST-V1");
export const HOST_INTRO_BCAST_VERSION = 1;
export const HOST_INTRO_BCAST_TRANSCRIPT_BYTES =
  HOST_INTRO_BCAST_MAGIC.byteLength + 1 + UUID_BYTES + ED25519_PUBLIC_KEY_BYTES * 2;

export const DEVICE_INTRO_MAGIC = textEncoder.encode("SPAWN-DEVICE-INTRO-V1");
export const DEVICE_INTRO_VERSION = 1;
export const DEVICE_INTRO_TRANSCRIPT_BYTES =
  DEVICE_INTRO_MAGIC.byteLength +
  1 +
  UUID_BYTES +
  ED25519_PUBLIC_KEY_BYTES * 2 +
  UUID_BYTES +
  ED25519_PUBLIC_KEY_BYTES;

/** Ceremonies hand over a handful of peers; the relay caps the list server-side. */
export const MAX_DEVICE_INTRODUCTIONS = 32;

/**
 * `magic ‖ version ‖ account ‖ publisher_pk ‖ host_pk` — the DURABLE broadcast
 * form: unscoped to any recipient, published to the account store whenever a
 * device verifies a host out of band. Deliberately a different domain than the
 * ceremony-scoped SPAWN-HOST-INTRO-V1 (which binds a joiner): replaying a true
 * broadcast to another device of the same account is harmless by construction,
 * and cross-account replay dies on the account binding.
 */
export function encodeHostIntroductionBroadcastTranscript(
  accountId: string,
  publisherPublicKeyWire: string,
  hostPublicKeyWire: string,
): Uint8Array {
  const publisherPublicKey = decodeEd25519PublicKeyWire(publisherPublicKeyWire);
  const hostPublicKey = decodeEd25519PublicKeyWire(hostPublicKeyWire);
  const output = new Uint8Array(HOST_INTRO_BCAST_TRANSCRIPT_BYTES);
  let offset = 0;
  for (const field of [
    HOST_INTRO_BCAST_MAGIC,
    Uint8Array.of(HOST_INTRO_BCAST_VERSION),
    uuidBytes(accountId, "account id"),
    publisherPublicKey,
    hostPublicKey,
  ]) {
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
}

/**
 * `magic ‖ version ‖ account ‖ introducer_pk ‖ peer_pk ‖ peer_device_id ‖ joiner_pk`
 * — a device-key introduction carried on the add-device ceremony: the approver
 * hands the joiner the device keys IT learned firsthand, so the joiner can later
 * verify those devices' broadcast host introductions without ever having met
 * them. Scoped to the joiner exactly like the ceremony host introductions.
 */
export function encodeDeviceIntroductionTranscript(
  accountId: string,
  introducerPublicKeyWire: string,
  peerPublicKeyWire: string,
  peerDeviceId: string,
  joinerPublicKeyWire: string,
): Uint8Array {
  const introducerPublicKey = decodeEd25519PublicKeyWire(introducerPublicKeyWire);
  const peerPublicKey = decodeEd25519PublicKeyWire(peerPublicKeyWire);
  const joinerPublicKey = decodeEd25519PublicKeyWire(joinerPublicKeyWire);
  if (encodeBase64Url(peerPublicKey) === encodeBase64Url(joinerPublicKey)) {
    // Introducing the joiner to itself says nothing.
    throw new Error("a device may not be introduced to itself");
  }
  const output = new Uint8Array(DEVICE_INTRO_TRANSCRIPT_BYTES);
  let offset = 0;
  for (const field of [
    DEVICE_INTRO_MAGIC,
    Uint8Array.of(DEVICE_INTRO_VERSION),
    uuidBytes(accountId, "account id"),
    introducerPublicKey,
    peerPublicKey,
    uuidBytes(peerDeviceId, "peer device id"),
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

async function verifyTranscriptSignature(
  transcript: Uint8Array,
  signatureWire: string,
  signerPublicKeyWire: string,
): Promise<boolean> {
  const ownedTranscript = new ArrayBuffer(transcript.byteLength);
  new Uint8Array(ownedTranscript).set(transcript);
  const signature = decodeBase64Url(signatureWire, ED25519_SIGNATURE_BYTES);
  const ownedSignature = new ArrayBuffer(signature.byteLength);
  new Uint8Array(ownedSignature).set(signature);
  const key = await importEd25519PublicKeyWire(signerPublicKeyWire);
  return crypto.subtle.verify({ name: "Ed25519" }, key, ownedSignature, ownedTranscript);
}

/** One broadcast row as the store serves it. Untrusted until verified. */
export interface ClaimedBroadcastIntroduction {
  readonly publisher_device_id: string;
  readonly publisher_public_key: string;
  readonly host_id: string;
  readonly host_name: string;
  readonly host_public_key: string;
  readonly signature: string;
}

export interface BroadcastAcceptancePlan {
  readonly accepted: readonly AcceptedHostIntroduction[];
  /**
   * Rows from publishers this device holds no firsthand key for. EXPECTED for
   * a device approved before its peers learned to introduce themselves — not
   * an error, just not yet trustable. Counted so the caller can stay quiet.
   */
  readonly unknownPublisher: number;
  /** Signature/shape failures: possible tampering, worth a quiet trace. */
  readonly rejected: readonly string[];
}

/**
 * RECIPIENT side of the continuous gossip: decide which broadcast rows to
 * trust. The entire security is the peer-key rule — a row counts ONLY if its
 * claimed publisher key is one this device learned FIRSTHAND (ceremony-pinned,
 * or handed over inside a ceremony by a key that was). The server's claim of
 * who published is display data; the signature must verify under the firsthand
 * key itself. Rows published by this device, or by keys it does not hold, are
 * skipped without trust changing either way.
 */
export async function planBroadcastIntroductionAcceptance(input: {
  accountId: string;
  ownPublicKey: string;
  /**
   * Firsthand peer device keys (wire form) — the only acceptable signers
   * besides this device itself.
   */
  trustedPeerKeys: ReadonlySet<string>;
  claimed: readonly ClaimedBroadcastIntroduction[];
}): Promise<BroadcastAcceptancePlan> {
  const accepted: AcceptedHostIntroduction[] = [];
  const rejected: string[] = [];
  let unknownPublisher = 0;
  for (const item of input.claimed) {
    const name = typeof item.host_name === "string" && item.host_name ? item.host_name : "a host";
    // A row under this device's OWN key is firsthand by construction: only
    // its private key could have signed it, and that key is checked against
    // the local identity, never the row. The desktop app publishes the hosts
    // it possessed under the very key it then hands to the page it hosts
    // (desktop-device-handover.ts), so those rows are how that page learns
    // its own computer.
    const own = item.publisher_public_key === input.ownPublicKey;
    if (!own && !input.trustedPeerKeys.has(item.publisher_public_key)) {
      unknownPublisher += 1;
      continue;
    }
    try {
      const transcript = encodeHostIntroductionBroadcastTranscript(
        input.accountId,
        item.publisher_public_key,
        item.host_public_key,
      );
      const valid = await verifyTranscriptSignature(
        transcript,
        item.signature,
        item.publisher_public_key,
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
  return { accepted, unknownPublisher, rejected };
}

/** One relayed device introduction. Untrusted until verified. */
export interface ClaimedDeviceIntroduction {
  readonly device_id: string;
  readonly device_label: string;
  readonly device_public_key: string;
  readonly signature: string;
}

export interface AcceptedDeviceIntroduction {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly devicePublicKey: string;
}

export interface DeviceIntroductionAcceptancePlan {
  readonly accepted: readonly AcceptedDeviceIntroduction[];
  readonly rejected: readonly string[];
}

/**
 * JOINER side: which relayed device introductions are real. Verified against
 * the CEREMONY-PINNED approver key and this device's own key — never anything
 * the relay currently claims. The approver's own key is NOT accepted through
 * this path (the ceremony itself is its provenance), and a peer equal to this
 * device is vacuous.
 */
export async function planDeviceIntroductionAcceptance(input: {
  accountId: string;
  /** The approver key pinned at SAS-compute time. */
  pinnedIntroducerPublicKey: string;
  /** This device's own identity key (also pinned by the ceremony). */
  ownPublicKey: string;
  claimed: readonly ClaimedDeviceIntroduction[];
}): Promise<DeviceIntroductionAcceptancePlan> {
  const accepted: AcceptedDeviceIntroduction[] = [];
  const rejected: string[] = [];
  for (const item of input.claimed.slice(0, MAX_DEVICE_INTRODUCTIONS)) {
    const label =
      typeof item.device_label === "string" && item.device_label ? item.device_label : "a device";
    if (item.device_public_key === input.ownPublicKey) continue;
    if (item.device_public_key === input.pinnedIntroducerPublicKey) continue;
    try {
      const transcript = encodeDeviceIntroductionTranscript(
        input.accountId,
        input.pinnedIntroducerPublicKey,
        item.device_public_key,
        item.device_id,
        input.ownPublicKey,
      );
      const valid = await verifyTranscriptSignature(
        transcript,
        item.signature,
        input.pinnedIntroducerPublicKey,
      );
      if (!valid) {
        rejected.push(`${label}: the introduction did not verify`);
        continue;
      }
      accepted.push({
        deviceId: item.device_id,
        deviceLabel: label,
        devicePublicKey: item.device_public_key,
      });
    } catch (cause) {
      rejected.push(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { accepted, rejected };
}
