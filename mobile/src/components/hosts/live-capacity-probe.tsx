import { useEffect, useRef, useState } from "react";
import type { HostMetrics } from "@/components/hosts/host-model";
import { useLiveHostMetrics } from "@/components/hosts/live-host-metrics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";

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
  }, [state]);

  useLiveHostMetrics({
    enabled,
    transport,
    state,
    onMetrics: (metrics) => callbacks.current.onMetrics(metrics),
    onUnavailable: (message) => callbacks.current.onUnavailable(message),
  });

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
