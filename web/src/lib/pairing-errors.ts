import { ApiError } from "@/lib/api";
import type { SetupClaimError } from "@/lib/setup-claims";

export type PairingFailureCode = SetupClaimError;

export const PAIRING_FAILURE_COPY: Record<PairingFailureCode, string> = {
  expired: "That code expired. On the machine, run spawnd possess again.",
  denied: "The approval was declined in the browser. Nothing was registered.",
  key_conflict:
    "This machine was set up before, under a different SPAWN D account, and that account still holds its identity. Nothing was changed.\n" +
    "• To use it under that account: sign in there and approve as usual.\n" +
    "• To hand it to this account: remove the host from the old account's Hosts page first, then run spawnd possess again.\n" +
    "• To keep both accounts on this machine: spawnd possess --new-account",
  pin_conflict:
    "The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh.",
  pin_limit:
    "This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.",
};

const FAILURE_CODES = new Set<PairingFailureCode>([
  "expired",
  "denied",
  "key_conflict",
  "pin_conflict",
  "pin_limit",
]);

function asFailureCode(value: unknown): PairingFailureCode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (FAILURE_CODES.has(normalized as PairingFailureCode)) {
    return normalized as PairingFailureCode;
  }
  if (normalized.includes("user code is expired") || normalized.includes("expired_token")) {
    return "expired";
  }
  for (const code of FAILURE_CODES) {
    if (normalized.includes(code)) return code;
  }
  return null;
}

/** Extract the stable catalogue code from any API error location or shape. */
export function pairingFailureCode(error: unknown): PairingFailureCode | null {
  if (error instanceof ApiError) {
    const direct = [error.code, error.message, error.detail]
      .map(asFailureCode)
      .find((value) => value !== null);
    if (direct) return direct;
    if (typeof error.detail === "object" && error.detail !== null) {
      const detail = error.detail as Record<string, unknown>;
      return (
        asFailureCode(detail.code) ?? asFailureCode(detail.error) ?? asFailureCode(detail.message)
      );
    }
  }
  return asFailureCode(error instanceof Error ? error.message : error);
}

export function pairingFailureMessage(error: unknown): string | null {
  const code = pairingFailureCode(error);
  return code ? PAIRING_FAILURE_COPY[code] : null;
}
