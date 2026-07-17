"use client";

import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type BrowserDevice, browserDevices } from "./api";
import {
  createBrowserDeviceRegistrationProof,
  deleteBrowserDeviceIdentity,
  loadBrowserDeviceIdentityPublicKey,
  loadOrCreateBrowserDeviceIdentity,
} from "./browser-device-identity";
import { ed25519PublicKeyFingerprint } from "./signed-signal";

const REVOCATION_MARKER_PREFIX = "spawn.browser-device.revocation.v1.";

export type BrowserDeviceRegistrationState =
  | { status: "ready"; device: BrowserDevice; publicKey: string }
  | { status: "cleanup_pending"; publicKey: string }
  | { status: "revoked"; publicKey: string };

interface RevocationMarker {
  status: "cleanup_pending" | "revoked";
  publicKey: string;
}

function markerKey(userId: string): string {
  return `${REVOCATION_MARKER_PREFIX}${userId}`;
}

function parseMarker(value: string | null): RevocationMarker | null {
  if (value === null) return null;
  const separator = value.indexOf(":");
  if (separator < 0) throw new Error("browser identity revocation marker is corrupt");
  const status = value.slice(0, separator);
  const publicKey = value.slice(separator + 1);
  if ((status !== "cleanup_pending" && status !== "revoked") || publicKey.length !== 43) {
    throw new Error("browser identity revocation marker is corrupt");
  }
  return { status, publicKey };
}

export function readBrowserDeviceRevocationMarker(userId: string): RevocationMarker | null {
  return parseMarker(window.localStorage.getItem(markerKey(userId)));
}

function writeMarker(userId: string, marker: RevocationMarker): void {
  // This marker contains only the already-public key. Private keys, JWKs, and
  // signatures remain in neither Web Storage nor logs.
  window.localStorage.setItem(markerKey(userId), `${marker.status}:${marker.publicKey}`);
}

export async function beginBrowserDeviceLocalCleanup(
  userId: string,
  expectedPublicKey: string,
): Promise<"cleanup_pending" | "revoked"> {
  const publicKey = await loadBrowserDeviceIdentityPublicKey(userId);
  if (publicKey === null) {
    writeMarker(userId, { status: "revoked", publicKey: expectedPublicKey });
    return "revoked";
  }
  if (publicKey !== expectedPublicKey) {
    throw new Error("local browser identity does not match the revoked server key");
  }
  writeMarker(userId, {
    status: "cleanup_pending",
    publicKey: expectedPublicKey,
  });
  return "cleanup_pending";
}

export async function finishBrowserDeviceLocalCleanup(
  userId: string,
  expectedPublicKey: string,
): Promise<void> {
  const marker = readBrowserDeviceRevocationMarker(userId);
  if (
    marker === null ||
    marker.status !== "cleanup_pending" ||
    marker.publicKey !== expectedPublicKey
  ) {
    throw new Error("browser identity cleanup state changed; refresh before retrying");
  }
  await deleteBrowserDeviceIdentity(userId, expectedPublicKey);
  writeMarker(userId, { status: "revoked", publicKey: expectedPublicKey });
}

export function allowExplicitBrowserIdentityReplacement(
  userId: string,
  expectedPublicKey: string,
): void {
  const marker = readBrowserDeviceRevocationMarker(userId);
  if (marker?.status !== "revoked" || marker.publicKey !== expectedPublicKey) {
    throw new Error("browser identity replacement state changed; refresh before continuing");
  }
  window.localStorage.removeItem(markerKey(userId));
}

async function registerBrowserDevice(userId: string): Promise<BrowserDeviceRegistrationState> {
  const marker = readBrowserDeviceRevocationMarker(userId);
  if (marker !== null) return { status: marker.status, publicKey: marker.publicKey };

  const identity = await loadOrCreateBrowserDeviceIdentity(userId);
  const signature = await createBrowserDeviceRegistrationProof(identity, userId);
  const device = await browserDevices.register({
    key_algorithm: "ed25519",
    public_key: identity.publicKeyWire,
    signature,
  });
  const expectedFingerprint = await ed25519PublicKeyFingerprint(identity.publicKeyWire);
  if (
    device.key_algorithm !== "ed25519" ||
    device.public_key !== identity.publicKeyWire ||
    device.fingerprint !== expectedFingerprint ||
    device.revoked_at !== null
  ) {
    throw new Error("browser registration response did not match the submitted active key");
  }
  return { status: "ready", device, publicKey: identity.publicKeyWire };
}

/** Peer invalidations may re-open trust only after bypassing every cached registration result. */
export async function fetchFreshBrowserDeviceRegistration(
  queryClient: QueryClient,
  userId: string,
): Promise<BrowserDeviceRegistrationState> {
  const queryKey = browserDeviceRegistrationQueryKey(userId);
  await queryClient.cancelQueries({ queryKey });
  queryClient.removeQueries({ queryKey });
  return await queryClient.fetchQuery({
    queryKey,
    queryFn: () => registerBrowserDevice(userId),
    staleTime: 0,
  });
}

export function browserIdentityConnectionsAllowed(
  state: BrowserDeviceRegistrationState | undefined,
): boolean {
  return state?.status === "ready";
}

export function browserDeviceRegistrationQueryKey(userId: string) {
  return ["browser-device-registration", userId] as const;
}

export function useBrowserDeviceRegistration(userId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = browserDeviceRegistrationQueryKey(userId ?? "disabled");
  const query = useQuery({
    queryKey,
    queryFn: () => registerBrowserDevice(userId!),
    enabled: userId !== undefined,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (userId === undefined) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === markerKey(userId)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [queryClient, queryKey, userId]);

  return query;
}
