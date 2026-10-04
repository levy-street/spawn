/**
 * How long a carry will take, from the conversation's size and this
 * device's two connections — the one rate model the phone uses too (mobile
 * `move-facts.ts`), from spike S4: bulk is paced at 64 KiB per association
 * and counted until acknowledged, so a leg moves 64 KiB per round trip; the
 * relay caps a leg at the 0.9 MB/s S4 measured at 55 ms; the device pumps
 * both legs at once, so the slower one sets the pace; and stopping the
 * source, the commit and starting the target add a few seconds. Only the
 * device's own ceiling differs by platform: a browser encodes and moves
 * about 20 MB/s at most, where base64 and the CPU bind first.
 *
 * Shown only when it is long enough to matter (`SHOW_ESTIMATE_SECONDS`).
 */

export interface LegInfo {
  kind: "direct" | "stun" | "relay" | null;
  rttMs: number | null;
}

/** Below this, the dialog says nothing about time. */
export const SHOW_ESTIMATE_SECONDS = 15;

/** One bulk gate per connection: 64 KiB in flight per round trip (S4). */
const WINDOW_BYTES = 64 * 1024;
/** S4: about 0.9 MB/s through the relay at 55 ms. */
const RELAY_BYTES_PER_SECOND = 900_000;
/** A path whose round trip nobody measured yet. */
const UNMEASURED_RTT_MS = 60;
/** This browser's own ceiling, whatever the path. */
const DEVICE_CEILING_BYTES_PER_SECOND = 20_000_000;
/** Stopping the source, the commit, and starting the target. */
const FIXED_SECONDS = 3;

function legRate(leg: LegInfo): number {
  const rtt = Math.max(1, leg.rttMs ?? UNMEASURED_RTT_MS);
  const paced = (WINDOW_BYTES * 1000) / rtt;
  const capped = leg.kind === "relay" ? Math.min(paced, RELAY_BYTES_PER_SECOND) : paced;
  return Math.min(capped, DEVICE_CEILING_BYTES_PER_SECOND);
}

/** Seconds a carry of `bytes` should take over these legs. */
export function estimateSeconds(bytes: number, legs: readonly LegInfo[]): number {
  const rate = Math.min(DEVICE_CEILING_BYTES_PER_SECOND, ...legs.map(legRate));
  return FIXED_SECONDS + bytes / rate;
}
