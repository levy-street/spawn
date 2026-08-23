"use client";

import { useHostGossipSync } from "@/lib/host-gossip";

/**
 * Invisible carrier for the continuous host-key gossip (mesh R7): publishes
 * this device's verified hosts to the account store and pins the ones its
 * firsthand-known peers vouch. No screens, no vocabulary — a host simply
 * arrives already verified (docs/TRUST_UX.md: mechanism never reaches a
 * screen).
 */
export function HostGossipSync() {
  useHostGossipSync();
  return null;
}
