"use client";

/**
 * Trust history (DESIGN.md §4.4): the audited, newest-first record of every
 * trust-changing event — including failed ceremonies, which are the strongest
 * detection signal the roster owner gets (R4).
 */

import { Card, Dot, SectionTitle, type Tone } from "./bits";
import type { TrustEvent } from "./types";

export interface TrustHistoryProps {
  events: TrustEvent[];
}

function eventLine(e: TrustEvent): { text: string; tone: Tone } {
  switch (e.kind) {
    case "device-linked":
      return { text: `${e.deviceName} joined — approved by ${e.approvedBy}`, tone: "ok" };
    case "passkey-backed-device":
      return { text: `Your passkey backed ${e.deviceName}`, tone: "ok" };
    case "passkey-backed-host":
      return { text: `Your passkey backed ${e.hostName}`, tone: "ok" };
    case "host-paired":
      return { text: `${e.hostName} paired from ${e.byDeviceName}`, tone: "ok" };
    case "device-removed":
      return {
        text: `${e.deviceName} removed from ${e.byDeviceName} — permanent`,
        tone: "danger",
      };
    case "link-mismatch-stopped":
      return { text: "A link attempt was stopped — the codes didn't match", tone: "danger" };
    case "link-expired":
      return { text: "A link attempt expired unanswered", tone: "neutral" };
    case "account-restored":
      return { text: `Account restored on ${e.deviceName} with your passkey`, tone: "ok" };
    case "passkey-created":
      return { text: "Passkey created — new devices are now backed automatically", tone: "ok" };
    case "passkey-trust-reset":
      return {
        text: `Passkey trust was reset — ${
          e.orphanedHostNames.length > 0
            ? `${e.orphanedHostNames.join(", ")} need pairing again at the machine`
            : "no hosts were orphaned"
        }`,
        tone: "danger",
      };
  }
}

export function TrustHistory({ events }: TrustHistoryProps) {
  return (
    <Card>
      <SectionTitle>Trust history</SectionTitle>
      <p className="mt-1 mb-2 text-sm text-neutral-500">
        Everything that changed what your devices and hosts trust, newest first.
      </p>
      <div>
        {events.map((e) => {
          const { text, tone } = eventLine(e);
          return (
            <div
              key={e.id}
              className="flex items-baseline gap-2 border-t border-neutral-100 py-2 first:border-t-0"
            >
              <Dot tone={tone} />
              <span className="text-sm text-neutral-800">{text}</span>
              <span className="ml-auto text-xs whitespace-nowrap text-neutral-400">{e.at}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
