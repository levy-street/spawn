"use client";

import { useEffect, useState } from "react";

import {
  unsignedHostControlDestination,
  useHostControlClientFactory,
} from "@/lib/host-control-trust";
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
    let client: HostControlClient;
    try {
      client = factory.createClient(unsignedHostControlDestination(hostId));
    } catch {
      setState("error");
      return;
    }
    setClient(client);
    const unsubscribe = client.subscribe(setState);
    client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [enabled, factory, hostId]);

  return { client, state };
}
