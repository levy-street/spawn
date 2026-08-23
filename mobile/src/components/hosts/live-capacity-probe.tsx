import { useEffect, useRef, useState } from "react";
import type { HostMetrics } from "@/components/hosts/host-model";
import { parseHostMetrics } from "@/components/hosts/host-model";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";

const CAPACITY_REFRESH_MS = 1_000;

export interface LiveCapacityProbeProps {
  enabled: boolean;
  hostId: string;
  hostIdentityPublicKey: string | null;
  onMetrics(metrics: HostMetrics | null): void;
  onStateChange(state: TransportState): void;
  onUnavailable(message: string): void;
}

export function LiveCapacityProbe({
  enabled,
  hostId,
  hostIdentityPublicKey,
  onMetrics,
  onStateChange,
  onUnavailable,
}: LiveCapacityProbeProps): React.JSX.Element | null {
  const [transport, setTransport] = useState<HostTransport | null>(null);
  const [state, setState] = useState<TransportState>("idle");
  const callbacks = useRef({ onMetrics, onStateChange, onUnavailable });
  callbacks.current = { onMetrics, onStateChange, onUnavailable };

  useEffect(() => {
    callbacks.current.onStateChange(state);
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
        if (active) timer = setTimeout(() => void poll(), CAPACITY_REFRESH_MS);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, state, transport]);

  useEffect(() => {
    if (enabled) return;
    setState("idle");
    setTransport(null);
    callbacks.current.onMetrics(null);
  }, [enabled]);

  if (!enabled || hostIdentityPublicKey === null) return null;
  return (
    <HostTransportSurface
      hostId={hostId}
      hostIdentityPublicKey={hostIdentityPublicKey}
      onError={(error) => callbacks.current.onUnavailable(error.message)}
      onStateChange={setState}
      onTransport={setTransport}
    />
  );
}
