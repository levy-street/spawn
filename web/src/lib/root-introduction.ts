/**
 * Root-key introductions (docs/TRUST_DEVICE_MESH.md §4.1 — the `pk_R`
 * provenance rule, made continuous).
 *
 * A device may only ever treat a key as "the root" if it learned `pk_R`
 * FIRSTHAND — at mint, or from the unsealed passkey bundle. But the per-host
 * root anchor upgrade must be signed by a device the host PINS, and the
 * passkey can live on an unpinned (chain-admitted) device — the field-bug
 * shape: the heal's anchor upgrade 409s everywhere and the root anchors
 * nowhere. The structural cure is delivering `pk_R` to pinned devices over the
 * same firsthand gossip channel host keys ride: a device that knows the root
 * firsthand signs a domain-separated SPAWN-ROOT-INTRO-V1 statement; a
 * recipient honors it ONLY when the introducer's key is in its firsthand
 * peer-device-key store and the signature verifies against that firsthand
 * copy. The server is the mailbox — it can withhold rows (denial, which it
 * always could) but cannot forge one, and a signature under a key nobody
 * learned firsthand moves no trust.
 *
 * Conflict rule (fail-closed = deny only): if a verified introduction names a
 * DIFFERENT key than one already firsthand-recorded, nothing is recorded and
 * the conflict is surfaced loudly — never anchor either candidate
 * automatically. The single exception is ROTATION: a successor is accepted
 * only when the OLD root's revocation is corroborated by the roster row AND
 * the permanent tombstone table (mirroring hardening B2), the verified
 * introductions agree unanimously on one successor, and the successor itself
 * is not dead. When in doubt, do nothing.
 */

import { assessSealedRootRevocation } from "./root-revocation";
import {
  decodeBase64Url,
  decodeEd25519PublicKeyWire,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  encodeBase64Url,
  importEd25519PublicKeyWire,
} from "./signed-signal";

const textEncoder = new TextEncoder();

export const ROOT_INTRO_MAGIC = textEncoder.encode("SPAWN-ROOT-INTRO-V1");
export const ROOT_INTRO_VERSION = 1;
const UUID_BYTES = 16;

export const ROOT_INTRO_TRANSCRIPT_BYTES =
  ROOT_INTRO_MAGIC.byteLength + 1 + UUID_BYTES + ED25519_PUBLIC_KEY_BYTES * 2;

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
 * `magic ‖ version ‖ account ‖ introducer_pk ‖ root_pk` — byte-identical to
 * the server's `encode_root_intro_transcript` (a shared vector pins it).
 * The introducer key is in the bytes (the signer names itself), the root key
 * is the payload; the statement is deliberately unscoped to any recipient —
 * replaying a true introduction to another device of the account is harmless
 * by construction, and cross-account replay dies on the account binding.
 */
export function encodeRootIntroductionTranscript(
  accountId: string,
  introducerPublicKeyWire: string,
  rootPublicKeyWire: string,
): Uint8Array {
  const introducerPublicKey = decodeEd25519PublicKeyWire(introducerPublicKeyWire);
  const rootPublicKey = decodeEd25519PublicKeyWire(rootPublicKeyWire);
  if (encodeBase64Url(introducerPublicKey) === encodeBase64Url(rootPublicKey)) {
    // The root never introduces itself: a self-introduction is exactly the
    // bare server-claim shape this channel exists to replace.
    throw new Error("a key may not introduce itself as the root");
  }
  const output = new Uint8Array(ROOT_INTRO_TRANSCRIPT_BYTES);
  let offset = 0;
  for (const field of [
    ROOT_INTRO_MAGIC,
    Uint8Array.of(ROOT_INTRO_VERSION),
    uuidBytes(accountId, "account id"),
    introducerPublicKey,
    rootPublicKey,
  ]) {
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
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

/** One root introduction as the store serves it. Untrusted until verified. */
export interface ClaimedRootIntroduction {
  readonly introducer_device_id: string;
  readonly introducer_public_key: string;
  readonly root_public_key: string;
  readonly signature: string;
}

export interface RootIntroductionAcceptancePlan {
  /**
   * The one root key this device may durably record as firsthand-derived, or
   * null when nothing may change (nothing verified, already known, or any
   * doubt). Recording and anchoring beyond this value is forbidden.
   */
  readonly accept: string | null;
  /**
   * Loud trust inconsistencies: verified introductions that name a different
   * key than the one already held (or than each other) without corroborated
   * rotation. Nothing was recorded; the operator should hear about these.
   */
  readonly conflicts: readonly string[];
  /** Rows from introducers this device holds no firsthand key for. Expected
   * during rollout — not an error, just not yet trustable. */
  readonly unknownIntroducer: number;
  /** Signature/shape failures: possible tampering, worth a quiet trace. */
  readonly rejected: readonly string[];
}

/**
 * RECIPIENT side: decide whether the served introductions let this device
 * record `pk_R` as firsthand-derived. The entire security is the peer-key
 * rule (a row counts ONLY if its claimed introducer key is one this device
 * learned FIRSTHAND, and the signature verifies under that firsthand copy)
 * plus the fail-closed conflict rule documented on the module.
 */
export async function planRootIntroductionAcceptance(input: {
  accountId: string;
  ownPublicKey: string;
  /** Firsthand peer device keys (wire form) — the ONLY acceptable signers. */
  trustedPeerKeys: ReadonlySet<string>;
  /** The root key this device already holds firsthand, if any. */
  knownRootPublicKey: string | null;
  /** Roster rows, for corroborating a rotation (with the tombstones). */
  devices: readonly { public_key: string; revoked_at: string | null }[];
  /** The account's permanent add-only key tombstones. */
  tombstonedKeys: readonly string[];
  claimed: readonly ClaimedRootIntroduction[];
}): Promise<RootIntroductionAcceptancePlan> {
  const rejected: string[] = [];
  let unknownIntroducer = 0;
  const verifiedRootKeys = new Set<string>();
  for (const item of input.claimed) {
    if (item.introducer_public_key === input.ownPublicKey) continue; // our own rows
    if (!input.trustedPeerKeys.has(item.introducer_public_key)) {
      unknownIntroducer += 1;
      continue;
    }
    try {
      const transcript = encodeRootIntroductionTranscript(
        input.accountId,
        item.introducer_public_key,
        item.root_public_key,
      );
      const valid = await verifyTranscriptSignature(
        transcript,
        item.signature,
        item.introducer_public_key,
      );
      if (!valid) {
        rejected.push("a root introduction did not verify");
        continue;
      }
      verifiedRootKeys.add(item.root_public_key);
    } catch (cause) {
      rejected.push(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const conflicts: string[] = [];
  const deadKeys = new Set(input.tombstonedKeys);
  for (const device of input.devices) {
    if (device.revoked_at !== null) deadKeys.add(device.public_key);
  }
  const candidates = [...verifiedRootKeys];

  if (candidates.length === 0) {
    return { accept: null, conflicts, unknownIntroducer, rejected };
  }

  if (input.knownRootPublicKey !== null) {
    const successors = candidates.filter((key) => key !== input.knownRootPublicKey);
    if (successors.length === 0) {
      // Everything verified agrees with what this device already knows.
      return { accept: null, conflicts, unknownIntroducer, rejected };
    }
    const oldRootVerdict = assessSealedRootRevocation(
      input.knownRootPublicKey,
      input.devices,
      input.tombstonedKeys,
    );
    if (oldRootVerdict === "revoked" && successors.length === 1 && !deadKeys.has(successors[0])) {
      // Corroborated rotation: the old key is dead by roster AND permanent
      // tombstone (a server faking this must commit the lie into irreversible
      // deny-list state), and the introducers agree on one live successor.
      return { accept: successors[0], conflicts, unknownIntroducer, rejected };
    }
    conflicts.push(
      oldRootVerdict === "revoked"
        ? "introductions disagree about the successor root; nothing was recorded"
        : "a verified introduction names a different root than the one this device " +
            "holds, without corroborated revocation of the old one; nothing was recorded",
    );
    return { accept: null, conflicts, unknownIntroducer, rejected };
  }

  if (candidates.length > 1) {
    conflicts.push("verified introductions name conflicting roots; nothing was recorded");
    return { accept: null, conflicts, unknownIntroducer, rejected };
  }
  if (deadKeys.has(candidates[0])) {
    // A dead key must never be adopted as an authority (R10 tombstones are
    // permanent); doing nothing is the only safe move.
    return { accept: null, conflicts, unknownIntroducer, rejected };
  }
  return { accept: candidates[0], conflicts, unknownIntroducer, rejected };
}

/** One local pin's identity, as the sweep consumes it. */
export interface SweepPin {
  readonly hostPublicKey: string;
  readonly hostIds: readonly string[];
}

export interface RootAnchorSweepTarget {
  readonly hostId: string;
  /** From the LOCAL pin store — firsthand by definition, never the server's. */
  readonly hostPublicKey: string;
}

/**
 * THE SWEEP (pure planning half): which hosts this device should sign the
 * per-host root anchor endorsement for. A target requires all of:
 *
 *  1. this device holds an ACTIVE local pin for the host (the host key it
 *     signs over is firsthand);
 *  2. the advisory pin list shows THIS device pinned there (the endorser must
 *     be pinned or the server's 409 gate refuses — attempting anyway is
 *     harmless but pointless);
 *  3. the advisory pin list does NOT already show the root (idempotence; the
 *     daemon re-verifies and the route is idempotent on repeats anyway).
 *
 * The pin lists are server-claimed and advisory in BOTH directions: a lying
 * server can only cause a skipped or refused statement (denial it always
 * had), never a forged anchor — the daemon re-verifies the signature against
 * a key it already pins.
 */
export function planRootAnchorSweep(input: {
  ownDeviceId: string;
  rootDeviceId: string;
  pins: readonly SweepPin[];
  /** Transitively-live pin device-ids per host id (advisory). */
  pinsByHost: ReadonlyMap<string, readonly string[]>;
}): RootAnchorSweepTarget[] {
  const targets: RootAnchorSweepTarget[] = [];
  const seen = new Set<string>();
  for (const pin of input.pins) {
    for (const hostId of pin.hostIds) {
      if (seen.has(hostId)) continue;
      seen.add(hostId);
      const pinned = input.pinsByHost.get(hostId);
      if (pinned === undefined) continue; // unknown yet; a later sweep retries
      if (!pinned.includes(input.ownDeviceId)) continue;
      if (pinned.includes(input.rootDeviceId)) continue;
      targets.push({ hostId, hostPublicKey: pin.hostPublicKey });
    }
  }
  return targets;
}
