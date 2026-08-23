import { normalizeHostPairingCode, validateHostPairingCode } from "@/lib/validation";

export const PAIRING_CODE_CHARACTER_COUNT = 8;

export function formatPairingCodeInput(value: string): string {
  const compact = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]/gu, "")
    .slice(0, PAIRING_CODE_CHARACTER_COUNT);
  if (compact.length <= 4) return compact;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function pairingCodeError(value: string): string | null {
  return validateHostPairingCode(formatPairingCodeInput(value));
}

export function pairingCodeForRequest(value: string): string {
  const formatted = formatPairingCodeInput(value);
  const error = validateHostPairingCode(formatted);
  if (error !== null) throw new Error(error);
  return normalizeHostPairingCode(formatted);
}
