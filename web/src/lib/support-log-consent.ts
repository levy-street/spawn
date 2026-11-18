import { decodeEd25519PublicKeyWire } from "./signed-signal";

function uuidBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error("Invalid consent UUID");
  }
  return Uint8Array.from(value.replaceAll("-", "").match(/../gu)!, (pair) =>
    Number.parseInt(pair, 16),
  );
}

const magic = new TextEncoder().encode("SPAWN-SUPPORT-LOG-CONSENT-V1");

export interface SupportLogConsent {
  account_id: string;
  signer_device_id: string;
  signer_public_key: string;
  enabled: boolean;
  issued_at_ms: number;
}

export function checkedConsentTime(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Math.abs(Date.now() - value) > 86_400_000
  )
    throw new Error("Invalid consent time");
  return value;
}

export function encodeSupportLogConsent(statement: SupportLogConsent) {
  if (
    !Number.isSafeInteger(statement.issued_at_ms) ||
    statement.issued_at_ms < 0 ||
    typeof statement.enabled !== "boolean"
  )
    throw new Error("Invalid consent statement");
  const bytes = new Uint8Array(102);
  bytes.set(magic);
  bytes[28] = 1;
  bytes.set(uuidBytes(statement.account_id), 29);
  bytes.set(decodeEd25519PublicKeyWire(statement.signer_public_key), 45);
  bytes.set(uuidBytes(statement.signer_device_id), 77);
  bytes[93] = statement.enabled ? 1 : 0;
  const view = new DataView(bytes.buffer);
  view.setUint32(94, Math.floor(statement.issued_at_ms / 2 ** 32), false);
  view.setUint32(98, statement.issued_at_ms % 2 ** 32, false);
  return bytes;
}

export interface SignedSupportLogConsent extends SupportLogConsent {
  version: 1;
  signature: string;
  carried_endorsements: {
    account_id: string;
    endorser_public_key: string;
    endorsed_public_key: string;
    endorsed_device_id: string;
    signature: string;
  }[];
}
