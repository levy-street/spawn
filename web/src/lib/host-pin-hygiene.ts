import type { HostPinUndeliveredEvent } from "./alerts";
import type { HostPinUndeliveredReason } from "./api";

export interface HostPinCapacity {
  used: number;
  max: number;
}

export function hostPinCapacityWarning(capacity: HostPinCapacity | null): string | null {
  if (capacity === null || capacity.used < 28) return null;
  return `This host is close to its limit of approving devices (${capacity.used} of ${capacity.max}). Remove devices you no longer use under Access.`;
}

export function hostPinUndeliveredToast(host: string, reason: HostPinUndeliveredReason): string {
  const reasonSentence =
    reason === "pin_limit"
      ? "This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again."
      : reason === "invalid_chain"
        ? `${host} could not verify the approval. Approve the device again from a device ${host} already trusts.`
        : `Try approving again; if it keeps failing, run spawnd doctor on ${host}.`;
  return `The approval didn't reach ${host}. ${reasonSentence}`;
}

export function hostPinUndeliveredEventToast(
  event: Pick<HostPinUndeliveredEvent, "reason">,
  host: string,
): string {
  return hostPinUndeliveredToast(host, event.reason);
}
