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
import { type Host, hosts } from "@/lib/api";
import { type BrowserHostPin, browserHostPinServerOrigin } from "@/lib/browser-host-pins";
import { type BrowserTrustStatus, useBrowserTrust } from "@/lib/browser-trust";
import {
  type BrowserTrustEpochCapabilityFactory,
  BrowserTrustEpochCapabilityRegistry,
  type BrowserTrustEpochExpectation,
  type BrowserTrustEpochLease,
  useBrowserTrustEpochCapabilities,
} from "@/lib/browser-trust-capabilities";
import {
  getBrowserTrustSessionSnapshot,
  subscribeBrowserTrustSession,
} from "@/lib/browser-trust-events";
import { resolveHostWithinTrustEpoch } from "@/lib/browser-trust-operations";
import {
  HostControlClient,
  type HostControlClientOptions,
  type HostControlDestinationTrustMaterial,
  type HostControlTrustMaterial,
} from "@/lib/hostControl";

const MAX_HOST_CONTROL_CLIENTS_PER_EPOCH = 32;

type TrustedBrowserContext = Extract<BrowserTrustStatus, { status: "trusted" }>;

function expectationFor(trust: TrustedBrowserContext): BrowserTrustEpochExpectation {
  return {
    accountOwnerUserId: trust.accountOwnerUserId,
    browserDeviceId: trust.browserDeviceId,
    browserPublicKey: trust.browserPublicKey,
    epochKey: trust.epochKey,
  };
}

function pinnedHostControlDestination(
  accountOwnerUserId: string,
  hostId: string,
  serverOrigin: string,
  pin: BrowserHostPin,
): HostControlDestinationTrustMaterial {
  if (
    pin.accountId !== accountOwnerUserId ||
    pin.state !== "active" ||
    pin.origin !== serverOrigin ||
    !pin.hostIds.includes(hostId)
  ) {
    throw new DOMException(
      "An exact active local Host-ID pin is required for HostControl",
      "SecurityError",
    );
  }
  return {
    hostId,
    serverOrigin,
    peerIdentity: {
      status: "local_host_pin",
      algorithm: "ed25519",
      publicKey: pin.hostPublicKey,
      fingerprint: pin.hostFingerprint,
    },
  };
}

export interface HostControlTrustDependencies {
  readonly serverOrigin: () => string;
  readonly fetchHost: (hostId: string, signal: AbortSignal) => Promise<Host>;
  readonly resolvePin: (
    lease: BrowserTrustEpochLease,
    origin: string,
    host: Host,
  ) => Promise<BrowserHostPin>;
}

const hostControlTrustDependencies: HostControlTrustDependencies = {
  serverOrigin: browserHostPinServerOrigin,
  fetchHost: (hostId, signal) => hosts.get(hostId, signal),
  resolvePin: (lease, origin, host) =>
    resolveHostWithinTrustEpoch({
      lease,
      origin,
      hostId: host.id,
      claimedHostPublicKey: host.host_public_key ?? null,
      claimedHostFingerprint: host.host_key_fingerprint ?? null,
    }),
};

export class HostControlTrustRegistry {
  private trust: TrustedBrowserContext | null = null;
  private clients = new Set<HostControlClient>();
  private pendingResolutions = 0;
  private readonly internalCapabilities: BrowserTrustEpochCapabilityRegistry | null;

  constructor(
    private readonly acquireExternalCapability?: BrowserTrustEpochCapabilityFactory["acquire"],
    private readonly dependencies: HostControlTrustDependencies = hostControlTrustDependencies,
  ) {
    this.internalCapabilities = acquireExternalCapability
      ? null
      : new BrowserTrustEpochCapabilityRegistry();
  }

  applyTrust(next: BrowserTrustStatus): void {
    if (next.status !== "trusted") {
      this.invalidate();
      return;
    }
    if (
      this.trust?.accountOwnerUserId === next.accountOwnerUserId &&
      this.trust.browserDeviceId === next.browserDeviceId &&
      this.trust.browserPublicKey === next.browserPublicKey &&
      this.trust.epochKey === next.epochKey
    ) {
      return;
    }
    this.revokeClients();
    this.trust = next;
    this.internalCapabilities?.applyTrust(next);
  }

  invalidate(): void {
    this.internalCapabilities?.invalidate();
    this.trust = null;
    this.revokeClients();
  }

  private revokeClients(): void {
    const clients = [...this.clients];
    for (const client of clients) client.revokeTrust();
    this.clients.clear();
  }

  private acquireCapability(trust: TrustedBrowserContext): BrowserTrustEpochLease {
    const expected = expectationFor(trust);
    return this.acquireExternalCapability
      ? this.acquireExternalCapability(expected)
      : this.internalCapabilities!.acquire(expected);
  }

  async resolveClient(
    hostId: string,
    options?: HostControlClientOptions,
  ): Promise<HostControlClient> {
    const trust = this.trust;
    if (!trust) {
      throw new DOMException("A stable browser trust epoch is required", "InvalidStateError");
    }
    const lease = this.acquireCapability(trust);
    lease.assertActive();
    if (this.clients.size + this.pendingResolutions >= MAX_HOST_CONTROL_CLIENTS_PER_EPOCH) {
      throw new Error("Too many host control clients in this browser trust epoch");
    }
    this.pendingResolutions += 1;
    let reserved = true;
    try {
      const origin = this.dependencies.serverOrigin();
      lease.assertActive();
      const host = await this.dependencies.fetchHost(hostId, lease.signal);
      lease.assertActive();
      if (host.id !== hostId) {
        throw new DOMException(
          "Host API response ID does not match the HostControl destination",
          "SecurityError",
        );
      }
      const pin = await this.dependencies.resolvePin(lease, origin, host);
      lease.assertActive();
      this.pendingResolutions -= 1;
      reserved = false;
      return this.createResolvedClient(
        pinnedHostControlDestination(lease.accountOwnerUserId, hostId, origin, pin),
        options,
        lease,
      );
    } finally {
      if (reserved) this.pendingResolutions -= 1;
    }
  }

  private createResolvedClient(
    destination: HostControlDestinationTrustMaterial,
    options?: HostControlClientOptions,
    existingLease?: BrowserTrustEpochLease,
  ): HostControlClient {
    const trust = this.trust;
    if (!trust) {
      throw new DOMException("A stable browser trust epoch is required", "InvalidStateError");
    }
    const lease = existingLease ?? this.acquireCapability(trust);
    lease.assertActive();
    const acquire = (client: HostControlClient): boolean => {
      try {
        lease.assertActive();
      } catch {
        return false;
      }
      if (this.trust !== trust) {
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
      lifecycleSignal: lease.signal,
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
  createClient: (hostId: string, options?: HostControlClientOptions) => Promise<HostControlClient>;
};

const HostControlTrustCtx = createContext<HostControlClientFactory | null>(null);

export function HostControlTrustProvider({ children }: { children: ReactNode }) {
  const trust = useBrowserTrust();
  const capabilities = useBrowserTrustEpochCapabilities();
  const registryRef = useRef<HostControlTrustRegistry | null>(null);
  registryRef.current ??= new HostControlTrustRegistry((expected) =>
    capabilities.acquire(expected),
  );
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
      createClient: (hostId, options) => registry.resolveClient(hostId, options),
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
