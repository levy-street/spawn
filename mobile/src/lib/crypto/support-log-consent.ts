import { decodeBase64UrlExact, encodeUtf8, uuidToBytes } from "./bytes";

const magic = encodeUtf8("SPAWN-SUPPORT-LOG-CONSENT-V1");

export interface SupportLogConsent {
  account_id: string;
  signer_device_id: string;
  signer_public_key: string;
  enabled: boolean;
  issued_at_ms: number;
}

// Highest stored or signed time seen in this app instance, including across panel opens.
const newestTime = new Map<string, number>();

export function rememberConsentTime(accountId: string, time: number) {
  if (time > (newestTime.get(accountId) ?? -1)) newestTime.set(accountId, time);
}

export function checkedConsentTime(value: unknown, accountId: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= (newestTime.get(accountId) ?? -1) ||
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
  bytes.set(uuidToBytes(statement.account_id), 29);
  bytes.set(decodeBase64UrlExact(statement.signer_public_key, 32), 45);
  bytes.set(uuidToBytes(statement.signer_device_id), 77);
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
