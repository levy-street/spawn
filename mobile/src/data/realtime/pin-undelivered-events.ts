import type { HostPinUndeliveredTrustEvent } from "@/data/realtime/alert-socket";

const listeners = new Set<(event: HostPinUndeliveredTrustEvent) => void>();

export function publishPinUndeliveredEvent(event: HostPinUndeliveredTrustEvent): void {
  for (const listener of listeners) listener(event);
}

export function subscribePinUndeliveredEvents(
  listener: (event: HostPinUndeliveredTrustEvent) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
