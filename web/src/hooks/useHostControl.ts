"use client";

import { useEffect, useState } from "react";

import { useHostControlClientFactory } from "@/lib/host-control-trust";
import type { HostControlClient, HostControlState } from "@/lib/hostControl";

export function useHostControl(hostId: string | null, enabled = true) {
  const factory = useHostControlClientFactory();
  const [client, setClient] = useState<HostControlClient | null>(null);
  const [state, setState] = useState<HostControlState>("idle");

  useEffect(() => {
    setClient(null);
    if (!hostId || !enabled) {
      setState("idle");
      return;
    }
    let cancelled = false;
    let client: HostControlClient | null = null;
    let unsubscribe = () => {};
    void factory
      .createClient(hostId)
      .then((resolved) => {
        if (cancelled) {
          resolved.close();
          return;
        }
        client = resolved;
        setClient(resolved);
        unsubscribe = resolved.subscribe(setState);
        resolved.connect();
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
      unsubscribe();
      client?.close();
    };
  }, [enabled, factory, hostId]);

  return { client, state };
}
