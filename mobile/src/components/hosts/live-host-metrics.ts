import { useEffect, useRef } from "react";
import { type HostMetrics, parseHostMetrics } from "@/components/hosts/host-model";
import type { HostTransport, TransportState } from "@/terminal/transport/types";

/** How often exact figures are asked for, wherever a host's are on screen. */
export const LIVE_METRICS_INTERVAL_MS = 3_000;

export interface LiveHostMetricsOptions {
  /** Someone can see the figures right now; nothing is asked otherwise. */
  enabled: boolean;
  transport: HostTransport | null;
  state: TransportState;
  onMetrics(metrics: HostMetrics): void;
  onUnavailable(message: string): void;
}

/**
 * Ask a host for its exact figures (`host.metrics`) every three seconds over
 * this device's own channel to it, for as long as `enabled` holds and the
 * channel is ready. The server only ever sees the heartbeat's five-level
 * reading; these never leave the channel.
 */
export function useLiveHostMetrics({
  enabled,
  transport,
  state,
  onMetrics,
  onUnavailable,
}: LiveHostMetricsOptions): void {
  const callbacks = useRef({ onMetrics, onUnavailable });
  callbacks.current = { onMetrics, onUnavailable };

  useEffect(() => {
    if (!enabled || state !== "ready" || transport === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      try {
        const response = await transport.request<unknown>("host.metrics", {});
        if (!active) return;
        const metrics = parseHostMetrics(response);
        if (metrics === null) {
          callbacks.current.onUnavailable("This host returned an invalid live-capacity sample.");
        } else {
          callbacks.current.onMetrics(metrics);
        }
      } catch (error) {
        if (!active) return;
        callbacks.current.onUnavailable(
          error instanceof Error ? error.message : "Live capacity is unavailable.",
        );
      } finally {
        if (active) timer = setTimeout(() => void poll(), LIVE_METRICS_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, state, transport]);
}
