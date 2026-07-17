import {
  decodeBase64Url,
  decodeEd25519PublicKeyWire,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  importEd25519PublicKeyWire,
} from "./signed-signal";

const textEncoder = new TextEncoder();

export const BROWSER_DEVICE_REGISTRATION_MAGIC = textEncoder.encode("SPAWN-BROWSER-REGISTER-V1");
export const BROWSER_DEVICE_REGISTRATION_VERSION = 1;
export const BROWSER_DEVICE_REGISTRATION_TRANSCRIPT_BYTES =
  BROWSER_DEVICE_REGISTRATION_MAGIC.byteLength + 1 + 16 + ED25519_PUBLIC_KEY_BYTES;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BrowserDeviceRegistrationTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserDeviceRegistrationTranscriptError";
  }
}

function uuidBytes(userId: string): Uint8Array {
  if (!UUID_PATTERN.test(userId)) {
    throw new BrowserDeviceRegistrationTranscriptError(
      "authenticated user id must be a canonical lowercase UUID",
    );
  }
  const hex = userId.replaceAll("-", "");
  const output = new Uint8Array(16);
  for (let index = 0; index < output.byteLength; index += 1) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function encodeBrowserDeviceRegistrationTranscript(
  userId: string,
  publicKeyWire: string,
): Uint8Array {
  const publicKey = decodeEd25519PublicKeyWire(publicKeyWire);
  const output = new Uint8Array(BROWSER_DEVICE_REGISTRATION_TRANSCRIPT_BYTES);
  let offset = 0;
  output.set(BROWSER_DEVICE_REGISTRATION_MAGIC, offset);
  offset += BROWSER_DEVICE_REGISTRATION_MAGIC.byteLength;
  output[offset] = BROWSER_DEVICE_REGISTRATION_VERSION;
  offset += 1;
  output.set(uuidBytes(userId), offset);
  offset += 16;
  output.set(publicKey, offset);
  return output;
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(value.byteLength);
  new Uint8Array(output).set(value);
  return output;
}

export async function verifyBrowserDeviceRegistrationProof(
  userId: string,
  publicKeyWire: string,
  signatureWire: string,
): Promise<boolean> {
  const publicKey = await importEd25519PublicKeyWire(publicKeyWire);
  const transcript = encodeBrowserDeviceRegistrationTranscript(userId, publicKeyWire);
  const signature = decodeBase64Url(signatureWire, ED25519_SIGNATURE_BYTES);
  try {
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      ownedArrayBuffer(signature),
      ownedArrayBuffer(transcript),
    );
  } catch {
    return false;
  }
}
