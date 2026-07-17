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
import { type BrowserTrustStatus, useBrowserTrust } from "./browser-trust";
import {
  getBrowserTrustSessionSnapshot,
  subscribeBrowserTrustSession,
} from "./browser-trust-events";

type TrustedBrowserContext = Extract<BrowserTrustStatus, { status: "trusted" }>;

export interface BrowserTrustEpochExpectation {
  readonly accountOwnerUserId: string;
  readonly browserDeviceId: string;
  readonly browserPublicKey: string;
  readonly epochKey: string;
}

function expectationFor(trust: TrustedBrowserContext): BrowserTrustEpochExpectation {
  return Object.freeze({
    accountOwnerUserId: trust.accountOwnerUserId,
    browserDeviceId: trust.browserDeviceId,
    browserPublicKey: trust.browserPublicKey,
    epochKey: trust.epochKey,
  });
}

function sameExpectation(
  left: BrowserTrustEpochExpectation,
  right: BrowserTrustEpochExpectation,
): boolean {
  return (
    left.accountOwnerUserId === right.accountOwnerUserId &&
    left.browserDeviceId === right.browserDeviceId &&
    left.browserPublicKey === right.browserPublicKey &&
    left.epochKey === right.epochKey
  );
}

function epochEnded(): DOMException {
  return new DOMException("Browser trust epoch ended", "AbortError");
}

export class BrowserTrustEpochLease {
  readonly accountOwnerUserId: string;
  readonly browserDeviceId: string;
  readonly browserPublicKey: string;
  readonly epochKey: string;
  readonly signal: AbortSignal;

  constructor(
    private readonly registry: BrowserTrustEpochCapabilityRegistry,
    private readonly expectation: BrowserTrustEpochExpectation,
    private readonly controller: AbortController,
  ) {
    this.accountOwnerUserId = expectation.accountOwnerUserId;
    this.browserDeviceId = expectation.browserDeviceId;
    this.browserPublicKey = expectation.browserPublicKey;
    this.epochKey = expectation.epochKey;
    this.signal = controller.signal;
  }

  /** Check both abort state and exact registry ownership at every async boundary. */
  assertActive(): void {
    if (this.signal.aborted || !this.registry.isCurrent(this.expectation, this.controller)) {
      throw epochEnded();
    }
  }
}

/** One abort controller owns every capability issued for the exact trust epoch. */
export class BrowserTrustEpochCapabilityRegistry {
  private expectation: BrowserTrustEpochExpectation | null = null;
  private controller: AbortController | null = null;

  applyTrust(next: BrowserTrustStatus): void {
    if (next.status !== "trusted") {
      this.invalidate();
      return;
    }
    const expectation = expectationFor(next);
    if (
      this.expectation !== null &&
      this.controller !== null &&
      !this.controller.signal.aborted &&
      sameExpectation(this.expectation, expectation)
    ) {
      return;
    }
    this.invalidate();
    this.expectation = expectation;
    this.controller = new AbortController();
  }

  invalidate(): void {
    const controller = this.controller;
    this.expectation = null;
    this.controller = null;
    controller?.abort(epochEnded());
  }

  acquire(expected: BrowserTrustEpochExpectation): BrowserTrustEpochLease {
    const current = this.expectation;
    const controller = this.controller;
    if (
      current === null ||
      controller === null ||
      controller.signal.aborted ||
      !sameExpectation(current, expected)
    ) {
      throw new DOMException(
        "An exact account, registration, and browser trust epoch is required",
        "InvalidStateError",
      );
    }
    return new BrowserTrustEpochLease(this, current, controller);
  }

  expectationSnapshot(): BrowserTrustEpochExpectation | null {
    return this.expectation;
  }

  isCurrent(expectation: BrowserTrustEpochExpectation, controller: AbortController): boolean {
    return (
      this.expectation !== null &&
      this.controller === controller &&
      !controller.signal.aborted &&
      sameExpectation(this.expectation, expectation)
    );
  }
}

export interface BrowserTrustEpochCapabilityFactory {
  readonly expectation: BrowserTrustEpochExpectation;
  acquire(expected: BrowserTrustEpochExpectation): BrowserTrustEpochLease;
}

const BrowserTrustCapabilityCtx = createContext<BrowserTrustEpochCapabilityFactory | null>(null);

export function BrowserTrustCapabilityProvider({ children }: { children: ReactNode }) {
  const trust = useBrowserTrust();
  const registryRef = useRef<BrowserTrustEpochCapabilityRegistry | null>(null);
  registryRef.current ??= new BrowserTrustEpochCapabilityRegistry();
  const registry = registryRef.current;

  useLayoutEffect(() => registry.applyTrust(trust), [registry, trust]);
  useEffect(() => {
    return subscribeBrowserTrustSession(() => {
      if (getBrowserTrustSessionSnapshot().status === "invalidated") registry.invalidate();
    });
  }, [registry]);
  useEffect(() => () => registry.invalidate(), [registry]);

  const accountOwnerUserId = trust.status === "trusted" ? trust.accountOwnerUserId : "";
  const browserDeviceId = trust.status === "trusted" ? trust.browserDeviceId : "";
  const browserPublicKey = trust.status === "trusted" ? trust.browserPublicKey : "";
  const expectation = useMemo<BrowserTrustEpochExpectation>(
    () =>
      Object.freeze({
        accountOwnerUserId,
        browserDeviceId,
        browserPublicKey,
        epochKey: trust.epochKey,
      }),
    [accountOwnerUserId, browserDeviceId, browserPublicKey, trust.epochKey],
  );
  const factory = useMemo<BrowserTrustEpochCapabilityFactory>(
    () => ({
      expectation,
      acquire: (expected) => registry.acquire(expected),
    }),
    [expectation, registry],
  );

  return (
    <BrowserTrustCapabilityCtx.Provider value={factory}>
      {children}
    </BrowserTrustCapabilityCtx.Provider>
  );
}

export function useBrowserTrustEpochCapabilities(): BrowserTrustEpochCapabilityFactory {
  const value = useContext(BrowserTrustCapabilityCtx);
  if (value === null) {
    throw new Error(
      "useBrowserTrustEpochCapabilities must be used within BrowserTrustCapabilityProvider",
    );
  }
  return value;
}
