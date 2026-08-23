import { concatBytes, decodeBase64UrlExact, encodeUtf8, uuidToBytes } from "@/lib/crypto/bytes";
import {
  assertStrictEd25519PublicKey,
  signPureEd25519,
  verifyPureEd25519Strict,
} from "@/lib/crypto/ed25519";

const REGISTRATION_MAGIC = encodeUtf8("SPAWN-BROWSER-REGISTER-V1");
const APPROVAL_MAGIC = encodeUtf8("SPAWN-HOST-PAIR-APPROVE-V1");
const POSSESSION_MAGIC = encodeUtf8("SPAWN-HOST-PAIR-POSSESSION-V1");
const ENDORSEMENT_MAGIC = encodeUtf8("SPAWN-BROWSER-ENDORSE-V1");
const VERSION_ONE = Uint8Array.of(1);

function publicKey(value: string): Uint8Array {
  const bytes = decodeBase64UrlExact(value, 32);
  assertStrictEd25519PublicKey(bytes);
  return bytes;
}

export interface RegistrationTranscript {
  accountId: string;
  browserPublicKey: string;
}

export interface ApprovalTranscript {
  accountId: string;
  approvalNonce: string;
  hostPublicKey: string;
  browserPublicKey: string;
}

export interface PossessionTranscript {
  deviceCode: string;
  approvalNonce: string;
  hostPublicKey: string;
}

export interface EndorsementTranscript {
  accountId: string;
  hostPublicKey: string;
  endorserPublicKey: string;
  endorsedPublicKey: string;
  endorsedDeviceId: string;
}

export function encodeBrowserRegistrationV1(input: RegistrationTranscript): Uint8Array {
  return concatBytes(
    REGISTRATION_MAGIC,
    VERSION_ONE,
    uuidToBytes(input.accountId),
    publicKey(input.browserPublicKey),
  );
}

export function encodeHostPairApprovalV1(input: ApprovalTranscript): Uint8Array {
  return concatBytes(
    APPROVAL_MAGIC,
    VERSION_ONE,
    uuidToBytes(input.accountId),
    decodeBase64UrlExact(input.approvalNonce, 32),
    publicKey(input.hostPublicKey),
    publicKey(input.browserPublicKey),
  );
}

export function encodeHostPairPossessionV1(input: PossessionTranscript): Uint8Array {
  return concatBytes(
    POSSESSION_MAGIC,
    VERSION_ONE,
    decodeBase64UrlExact(input.deviceCode, 32),
    decodeBase64UrlExact(input.approvalNonce, 32),
    publicKey(input.hostPublicKey),
  );
}

export function encodeBrowserEndorsementV1(input: EndorsementTranscript): Uint8Array {
  return concatBytes(
    ENDORSEMENT_MAGIC,
    VERSION_ONE,
    uuidToBytes(input.accountId),
    publicKey(input.hostPublicKey),
    publicKey(input.endorserPublicKey),
    publicKey(input.endorsedPublicKey),
    uuidToBytes(input.endorsedDeviceId),
  );
}

export function signBrowserRegistrationV1(
  seed: Uint8Array,
  input: RegistrationTranscript,
): Uint8Array {
  return signPureEd25519(seed, encodeBrowserRegistrationV1(input));
}

export function signHostPairApprovalV1(seed: Uint8Array, input: ApprovalTranscript): Uint8Array {
  return signPureEd25519(seed, encodeHostPairApprovalV1(input));
}

export function signHostPairPossessionV1(
  seed: Uint8Array,
  input: PossessionTranscript,
): Uint8Array {
  return signPureEd25519(seed, encodeHostPairPossessionV1(input));
}

export function signBrowserEndorsementV1(
  seed: Uint8Array,
  input: EndorsementTranscript,
): Uint8Array {
  return signPureEd25519(seed, encodeBrowserEndorsementV1(input));
}

export function verifyBrowserRegistrationV1(
  publicKey: Uint8Array,
  input: RegistrationTranscript,
  signature: Uint8Array,
): boolean {
  return verifyPureEd25519Strict(publicKey, encodeBrowserRegistrationV1(input), signature);
}

export function verifyHostPairApprovalV1(
  publicKey: Uint8Array,
  input: ApprovalTranscript,
  signature: Uint8Array,
): boolean {
  return verifyPureEd25519Strict(publicKey, encodeHostPairApprovalV1(input), signature);
}

export function verifyHostPairPossessionV1(
  publicKey: Uint8Array,
  input: PossessionTranscript,
  signature: Uint8Array,
): boolean {
  return verifyPureEd25519Strict(publicKey, encodeHostPairPossessionV1(input), signature);
}

export function verifyBrowserEndorsementV1(
  publicKey: Uint8Array,
  input: EndorsementTranscript,
  signature: Uint8Array,
): boolean {
  return verifyPureEd25519Strict(publicKey, encodeBrowserEndorsementV1(input), signature);
}
