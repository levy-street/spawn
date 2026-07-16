"use client";

import { useEffect, useMemo, useState } from "react";

import { HostControlClient, type HostControlState } from "@/lib/hostControl";

export function useHostControl(hostId: string | null, enabled = true) {
  const client = useMemo(() => (hostId ? new HostControlClient(hostId) : null), [hostId]);
  const [state, setState] = useState<HostControlState>("idle");

  useEffect(() => {
    if (!client || !enabled) {
      setState("idle");
      return;
    }
    const unsubscribe = client.subscribe(setState);
    client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [client, enabled]);

  return { client, state };
}
