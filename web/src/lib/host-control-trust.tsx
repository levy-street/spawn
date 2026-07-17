"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { type BrowserTrustStatus, useBrowserTrust } from "@/lib/browser-trust";
import {
  getBrowserTrustSessionSnapshot,
  subscribeBrowserTrustSession,
} from "@/lib/browser-trust-events";
import {
  HostControlClient,
  type HostControlClientOptions,
  type HostControlDestinationTrustMaterial,
  type HostControlTrustMaterial,
} from "@/lib/hostControl";

const MAX_HOST_CONTROL_CLIENTS_PER_EPOCH = 32;

type TrustedBrowserContext = Extract<BrowserTrustStatus, { status: "trusted" }>;

export function unsignedHostControlDestination(
  hostId: string,
): HostControlDestinationTrustMaterial {
  return { hostId, peerIdentity: { status: "unsigned_not_implemented" } };
}

export class HostControlTrustRegistry {
  private trust: TrustedBrowserContext | null = null;
  private controller: AbortController | null = null;
  private clients = new Set<HostControlClient>();

  applyTrust(next: BrowserTrustStatus): void {
    if (next.status !== "trusted") {
      this.invalidate();
      return;
    }
    if (this.trust?.epochKey === next.epochKey && !this.controller?.signal.aborted) return;
    this.invalidate();
    this.trust = next;
    this.controller = new AbortController();
  }

  invalidate(): void {
    const controller = this.controller;
    this.controller = null;
    this.trust = null;
    const clients = [...this.clients];
    controller?.abort(new DOMException("Browser trust epoch ended", "AbortError"));
    for (const client of clients) client.revokeTrust();
    this.clients.clear();
  }

  createClient(
    destination: HostControlDestinationTrustMaterial,
    options?: HostControlClientOptions,
  ): HostControlClient {
    const trust = this.trust;
    const controller = this.controller;
    if (!trust || !controller || controller.signal.aborted) {
      throw new DOMException("A stable browser trust epoch is required", "InvalidStateError");
    }
    const acquire = (client: HostControlClient): boolean => {
      if (this.trust !== trust || this.controller !== controller || controller.signal.aborted) {
        return false;
      }
      if (!this.clients.has(client) && this.clients.size >= MAX_HOST_CONTROL_CLIENTS_PER_EPOCH) {
        throw new Error("Too many host control clients in this browser trust epoch");
      }
      this.clients.add(client);
      return true;
    };
    const material: HostControlTrustMaterial = {
      accountOwnerUserId: trust.accountOwnerUserId,
      trustEpochKey: trust.epochKey,
      browserRegistration: {
        deviceId: trust.browserDeviceId,
        publicKey: trust.browserPublicKey,
      },
      destination,
      lifecycleSignal: controller.signal,
      acquire,
      release: (client) => this.clients.delete(client),
    };
    return new HostControlClient(destination.hostId, material, options);
  }

  activeClientCount(): number {
    return this.clients.size;
  }
}

type HostControlClientFactory = {
  epochKey: string;
  createClient: (
    destination: HostControlDestinationTrustMaterial,
    options?: HostControlClientOptions,
  ) => HostControlClient;
};

const HostControlTrustCtx = createContext<HostControlClientFactory | null>(null);

export function HostControlTrustProvider({ children }: { children: ReactNode }) {
  const trust = useBrowserTrust();
  const registryRef = useRef<HostControlTrustRegistry | null>(null);
  registryRef.current ??= new HostControlTrustRegistry();
  const registry = registryRef.current;

  useLayoutEffect(() => registry.applyTrust(trust), [registry, trust]);
  useEffect(() => {
    return subscribeBrowserTrustSession(() => {
      if (getBrowserTrustSessionSnapshot().status === "invalidated") registry.invalidate();
    });
  }, [registry]);
  useEffect(() => () => registry.invalidate(), [registry]);

  const factory = useMemo<HostControlClientFactory>(
    () => ({
      epochKey: trust.epochKey,
      createClient: (destination, options) => registry.createClient(destination, options),
    }),
    [registry, trust.epochKey],
  );

  return <HostControlTrustCtx.Provider value={factory}>{children}</HostControlTrustCtx.Provider>;
}

export function useHostControlClientFactory(): HostControlClientFactory {
  const value = useContext(HostControlTrustCtx);
  if (!value) {
    throw new Error("useHostControlClientFactory must be used within HostControlTrustProvider");
  }
  return value;
}
