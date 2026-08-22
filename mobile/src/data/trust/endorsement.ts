import { createEndorsement } from "@/data/api/endpoints/trust";
import type { BrowserEndorsementCreate, BrowserEndorsementOut } from "@/data/api/schemas/trust";
import { formatHostFingerprint, type HostPin, type HostPinStore } from "@/data/trust/host-pins";
import { decodeBase64UrlExact, encodeBase64Url } from "@/lib/crypto/bytes";
import { verifyPureEd25519Strict } from "@/lib/crypto/ed25519";
import { deviceIdentity, setDeviceIdentityAccount } from "@/lib/crypto/identity";
import { encodeBrowserEndorsementV1 } from "@/lib/crypto/transcripts";

const VERIFIED_ENDORSEMENT = Symbol("verified-endorsement");

export interface EndorsementIntroduction {
  accountId: string;
  serverOrigin: string;
  hostId: string;
  hostPublicKey: string;
  endorserDeviceId: string;
  endorserPublicKey: string;
  endorsedDeviceId: string;
  endorsedPublicKey: string;
  signature: string;
}

export interface VerifiedEndorsement extends EndorsementIntroduction {
  readonly endorserFingerprint: string;
  readonly hostFingerprint: string;
  readonly [VERIFIED_ENDORSEMENT]: true;
}

export interface EndorsementApi {
  createEndorsement(input: BrowserEndorsementCreate): Promise<BrowserEndorsementOut>;
}

const endpointApi: EndorsementApi = { createEndorsement };

export const passkeyPrfCapability = {
  available: false as const,
  reason:
    "Passkey trust backup requires the installed spawn build. In Expo Go, approve this phone from another trusted device or pair each host directly.",
};

export function probePasskeyPrfCapability(): Promise<typeof passkeyPrfCapability> {
  return Promise.resolve(passkeyPrfCapability);
}

export function verifyEndorsementIntroduction(
  input: EndorsementIntroduction,
  expectedPhonePublicKey: string,
): VerifiedEndorsement {
  if (input.endorsedPublicKey !== expectedPhonePublicKey) {
    throw new Error("Endorsement is intended for a different device identity");
  }
  const transcript = encodeBrowserEndorsementV1({
    accountId: input.accountId,
    hostPublicKey: input.hostPublicKey,
    endorserPublicKey: input.endorserPublicKey,
    endorsedPublicKey: input.endorsedPublicKey,
    endorsedDeviceId: input.endorsedDeviceId,
  });
  const publicKey = decodeBase64UrlExact(input.endorserPublicKey, 32);
  const signature = decodeBase64UrlExact(input.signature, 64);
  if (!verifyPureEd25519Strict(publicKey, transcript, signature)) {
    throw new Error("Endorsement signature is invalid");
  }
  return Object.freeze({
    ...input,
    endorserFingerprint: formatHostFingerprint(input.endorserPublicKey),
    hostFingerprint: formatHostFingerprint(input.hostPublicKey),
    [VERIFIED_ENDORSEMENT]: true as const,
  });
}

export async function acceptVerifiedEndorsement(input: {
  endorsement: VerifiedEndorsement;
  expectedEndorserFingerprint: string;
  pinStore: HostPinStore;
}): Promise<HostPin> {
  if (input.endorsement[VERIFIED_ENDORSEMENT] !== true) {
    throw new Error("Endorsement has not been verified");
  }
  if (input.endorsement.endorserFingerprint !== input.expectedEndorserFingerprint) {
    throw new Error("Endorser fingerprint does not match the compared fingerprint");
  }
  return input.pinStore.approveExact({
    accountId: input.endorsement.accountId,
    serverOrigin: input.endorsement.serverOrigin,
    hostPublicKey: input.endorsement.hostPublicKey,
    hostId: input.endorsement.hostId,
  });
}

export async function createDeviceEndorsement(input: {
  accountId: string;
  hostId: string;
  hostPublicKey: string;
  endorserDeviceId: string;
  endorsedDeviceId: string;
  endorsedPublicKey: string;
  api?: EndorsementApi;
}): Promise<void> {
  setDeviceIdentityAccount(input.accountId);
  const publicKey = await deviceIdentity.publicKey();
  if (publicKey === null) throw new Error("Device identity is unavailable");
  const endorserPublicKey = encodeBase64Url(publicKey);
  const signature = await deviceIdentity.signEndorsement({
    accountId: input.accountId,
    hostPublicKey: input.hostPublicKey,
    endorserPublicKey,
    endorsedPublicKey: input.endorsedPublicKey,
    endorsedDeviceId: input.endorsedDeviceId,
  });
  try {
    const response = await (input.api ?? endpointApi).createEndorsement({
      host_id: input.hostId,
      endorser_device_id: input.endorserDeviceId,
      endorsed_device_id: input.endorsedDeviceId,
      signature: encodeBase64Url(signature),
    });
    if (
      response.host_id !== input.hostId ||
      response.endorser_device_id !== input.endorserDeviceId ||
      response.endorsed_device_id !== input.endorsedDeviceId ||
      response.endorsed_key_fingerprint !== formatHostFingerprint(input.endorsedPublicKey)
    ) {
      throw new Error("Endorsement response does not match the signed introduction");
    }
  } finally {
    signature.fill(0);
  }
}
