"use client";

import { useEffect, useRef, useState } from "react";

import { useHostControl } from "@/hooks/useHostControl";
import type { HostCapacitySample, HostCapacitySpec } from "@/lib/hostControl";

/**
 * Live, exact capacity for one host, straight from its daemon.
 *
 * This is the whole reason the host-control DataChannel exists for this
 * feature. The server is given a five-level bucket on the thirty-second
 * heartbeat and nothing finer; these numbers travel browser-to-daemon with no
 * server code path at all (docs/TRUST.md, `daemon/src/host_metrics.rs`).
 *
 * The cost is a real WebRTC connection per host — ICE, DTLS, and something to
 * keep alive — so this must only ever be switched on for a surface somebody is
 * looking at, and switched off when they stop. Callers pass `enabled` and are
 * expected to mean it.
 */

/** Poll interval. Matches the daemon's own minimum CPU sampling interval. */
const POLL_MS = 1_000;
/** Give up on a sample well before the next one is due. */
const REQUEST_TIMEOUT_MS = 4_000;

export interface HostCapacity {
  sample: HostCapacitySample | null;
  spec: HostCapacitySpec | null;
  /** True once a connection exists and the daemon offers `host.metrics`. */
  live: boolean;
  /** The host is reachable but reports no capacity (telemetry switched off). */
  unavailable: boolean;
}

export function useHostCapacity(hostId: string | null, enabled: boolean): HostCapacity {
  const { client, state, capabilities } = useHostControl(hostId, enabled);
  const [sample, setSample] = useState<HostCapacitySample | null>(null);
  const [spec, setSpec] = useState<HostCapacitySpec | null>(null);
  // Distinct from "the daemon does not offer metrics": this is a host that
  // does, and whose samples are not arriving.
  const [pollFailed, setPollFailed] = useState(false);
  // A poll must never stack on the one before it: a slow host would otherwise
  // accumulate in-flight requests until it hit the channel's pending cap.
  const inFlight = useRef(false);

  const supported = capabilities.has("host.metrics");
  const live = enabled && state === "ready" && supported;

  useEffect(() => {
    if (!client || !live) {
      inFlight.current = false;
      return;
    }
    let cancelled = false;

    const poll = async () => {
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      try {
        const result = await client.metrics({ timeoutMs: REQUEST_TIMEOUT_MS });
        if (cancelled) return;
        setSample(result.sample);
        if (result.spec) setSpec(result.spec);
        setPollFailed(false);
      } catch {
        // A refused or failed sample is not worth an error state on a panel
        // whose other half is still useful: keep the last reading, stop
        // claiming it is live, and let the next tick try again.
        if (!cancelled) setPollFailed(true);
      } finally {
        inFlight.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, live]);

  // Leaving the surface must not leave a stale number behind for the next host
  // that mounts into this slot.
  useEffect(() => {
    if (!enabled) {
      setSample(null);
      setPollFailed(false);
    }
  }, [enabled]);

  // Two ways to have nothing to draw, one meaning for the caller: connected,
  // and getting no capacity. A host that answered once and then went quiet
  // keeps its last reading and is not called unavailable — the number on
  // screen is stale, not absent.
  const capabilityMissing = enabled && state === "ready" && !supported;
  return {
    sample,
    spec,
    live: live && sample !== null,
    unavailable: capabilityMissing || (live && pollFailed && sample === null),
  };
}
