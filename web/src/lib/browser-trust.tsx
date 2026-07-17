"use client";

import { type Query, type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useAuth } from "@/lib/auth";
import {
  type BrowserDeviceRegistrationState,
  useBrowserDeviceRegistration,
} from "@/lib/browser-device-registration";
import {
  type BrowserTrustSessionSnapshot,
  getBrowserTrustSessionSnapshot,
  SERVER_BROWSER_TRUST_SESSION_SNAPSHOT,
  subscribeBrowserTrustSession,
} from "@/lib/browser-trust-events";

export type BrowserTrustBlockReason =
  | "auth_loading"
  | "auth_error"
  | "anonymous"
  | "session_invalidated"
  | "account_mismatch"
  | "registration_loading"
  | "registration_error"
  | "registration_unavailable"
  | "registration_cleanup_pending"
  | "registration_revoked";

export type BrowserTrustStatus =
  | {
      status: "blocked";
      reason: BrowserTrustBlockReason;
      epoch: number;
      epochKey: string;
      accountOwnerUserId: null;
      observedUserId: string | null;
    }
  | {
      status: "trusted";
      reason: null;
      epoch: number;
      epochKey: string;
      accountOwnerUserId: string;
      observedUserId: string;
      browserDeviceId: string;
      browserPublicKey: string;
    };

export interface BrowserTrustInputs {
  userId: string | null;
  authLoading: boolean;
  authError: unknown;
  session: BrowserTrustSessionSnapshot;
  registrationData: BrowserDeviceRegistrationState | undefined;
  registrationLoading: boolean;
  registrationError: unknown;
}

type DerivedBrowserTrust =
  | {
      status: "blocked";
      reason: BrowserTrustBlockReason;
      accountOwnerUserId: null;
      observedUserId: string | null;
      boundaryKey: string;
    }
  | {
      status: "trusted";
      reason: null;
      accountOwnerUserId: string;
      observedUserId: string;
      browserDeviceId: string;
      browserPublicKey: string;
      boundaryKey: string;
    };

export function deriveBrowserTrust(inputs: BrowserTrustInputs): DerivedBrowserTrust {
  const observedUserId = inputs.userId;
  if (inputs.session.status === "invalidated") {
    return {
      status: "blocked",
      reason: "session_invalidated",
      accountOwnerUserId: null,
      observedUserId,
      boundaryKey: `blocked:session:${inputs.session.serial}`,
    };
  }
  if (inputs.authLoading) {
    return {
      status: "blocked",
      reason: "auth_loading",
      accountOwnerUserId: null,
      observedUserId,
      boundaryKey: "blocked:auth_loading",
    };
  }
  if (inputs.authError !== null) {
    return {
      status: "blocked",
      reason: "auth_error",
      accountOwnerUserId: null,
      observedUserId,
      boundaryKey: "blocked:auth_error",
    };
  }
  if (observedUserId === null) {
    return {
      status: "blocked",
      reason: "anonymous",
      accountOwnerUserId: null,
      observedUserId: null,
      boundaryKey: "blocked:anonymous",
    };
  }
  if (inputs.session.status === "established" && inputs.session.ownerUserId !== observedUserId) {
    return {
      status: "blocked",
      reason: "account_mismatch",
      accountOwnerUserId: null,
      observedUserId,
      boundaryKey: `blocked:account_mismatch:${inputs.session.serial}`,
    };
  }
  if (inputs.registrationLoading) {
    return {
      status: "blocked",
      reason: "registration_loading",
      accountOwnerUserId: null,
      observedUserId,
      boundaryKey: `blocked:registration_loading:${observedUserId}`,
    };
  }
  if (inputs.registrationError !== null) {
    return {
      status: "blocked",
      reason: "registration_error",
      accountOwnerUserId: null,
      observedUserId,
      boundaryKey: `blocked:registration_error:${observedUserId}`,
    };
  }
  if (inputs.registrationData === undefined) {
    return {
      status: "blocked",
      reason: "registration_unavailable",
      accountOwnerUserId: null,
      observedUserId,
      boundaryKey: `blocked:registration_unavailable:${observedUserId}`,
    };
  }
  if (inputs.registrationData.status === "cleanup_pending") {
    return {
      status: "blocked",
      reason: "registration_cleanup_pending",
      accountOwnerUserId: null,
      observedUserId,
      boundaryKey: `blocked:registration_cleanup_pending:${observedUserId}`,
    };
  }
  if (inputs.registrationData.status === "revoked") {
    return {
      status: "blocked",
      reason: "registration_revoked",
      accountOwnerUserId: null,
      observedUserId,
      boundaryKey: `blocked:registration_revoked:${observedUserId}`,
    };
  }
  const { device, publicKey } = inputs.registrationData;
  return {
    status: "trusted",
    reason: null,
    accountOwnerUserId: observedUserId,
    observedUserId,
    browserDeviceId: device.id,
    browserPublicKey: publicKey,
    boundaryKey: `trusted:${observedUserId}:${device.id}:${publicKey}`,
  };
}

function isPreservedTrustQuery(query: Query, preserveUserId: string | null): boolean {
  if (query.queryKey[0] === "me") return true;
  return (
    preserveUserId !== null &&
    query.queryKey[0] === "browser-device-registration" &&
    query.queryKey[1] === preserveUserId
  );
}

/** Remove cached resources/capabilities owned by the previous account. */
export function discardBrowserOwnedQueryCache(
  queryClient: QueryClient,
  preserveUserId: string | null,
): void {
  const predicate = (query: Query) => !isPreservedTrustQuery(query, preserveUserId);
  void queryClient.cancelQueries({ predicate });
  queryClient.removeQueries({ predicate });
}

const BrowserTrustCtx = createContext<BrowserTrustStatus | null>(null);

export function BrowserTrustProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const auth = useAuth();
  const registration = useBrowserDeviceRegistration(auth.user?.id);
  const session = useSyncExternalStore(
    subscribeBrowserTrustSession,
    getBrowserTrustSessionSnapshot,
    () => SERVER_BROWSER_TRUST_SESSION_SNAPSHOT,
  );
  const derived = deriveBrowserTrust({
    userId: auth.user?.id ?? null,
    authLoading: auth.loading,
    authError: auth.error,
    session,
    registrationData: registration.data,
    registrationLoading: registration.isLoading || registration.isFetching,
    registrationError: registration.error,
  });

  // The epoch changes on every trust-boundary transition but remains stable
  // through ordinary same-account route changes and auth cache reads.
  const epochRef = useRef({ boundaryKey: derived.boundaryKey, epoch: 0 });
  if (epochRef.current.boundaryKey !== derived.boundaryKey) {
    epochRef.current = {
      boundaryKey: derived.boundaryKey,
      epoch: epochRef.current.epoch + 1,
    };
  }
  const trust = {
    ...derived,
    epoch: epochRef.current.epoch,
    epochKey: `${epochRef.current.epoch}:${derived.boundaryKey}`,
  } as BrowserTrustStatus;

  const previousRef = useRef<BrowserTrustStatus | null>(null);
  const handledInvalidationSerialRef = useRef(-1);
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = trust;

    if (session.status === "invalidated") {
      if (handledInvalidationSerialRef.current === session.serial) return;
      handledInvalidationSerialRef.current = session.serial;
      void queryClient.cancelQueries();
      queryClient.setQueryData(["me"], null);
      discardBrowserOwnedQueryCache(queryClient, null);
      return;
    }

    if (
      previous?.status === "trusted" &&
      (trust.status !== "trusted" || trust.epochKey !== previous.epochKey)
    ) {
      discardBrowserOwnedQueryCache(queryClient, trust.observedUserId);
    }
  }, [queryClient, session.serial, session.status, trust]);

  return <BrowserTrustCtx.Provider value={trust}>{children}</BrowserTrustCtx.Provider>;
}

export function useBrowserTrust(): BrowserTrustStatus {
  const value = useContext(BrowserTrustCtx);
  if (!value) throw new Error("useBrowserTrust must be used within BrowserTrustProvider");
  return value;
}
