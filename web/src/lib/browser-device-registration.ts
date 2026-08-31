"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ApiError, type BrowserDevice, browserDevices, trust } from "./api";
import {
  adoptBrowserDeviceIdentity,
  BrowserDeviceIdentityError,
  createBrowserDeviceRegistrationProof,
  deleteBrowserDeviceIdentity,
  loadBrowserDeviceIdentity,
  loadOrCreateBrowserDeviceIdentity,
} from "./browser-device-identity";
import { takeDesktopDeviceHandover } from "./desktop-device-handover";
import { CryptoUnavailableError } from "./signed-signal";

const REVOCATION_MARKER_PREFIX = "spawn.browser-device.revocation.v1.";

export type BrowserDeviceRegistrationState =
  | {
      status: "ready";
      device: BrowserDevice;
      publicKey: string;
      /** A removed identity was replaced during this registration pass. */
      recoveredFromRevocation?: boolean;
    }
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
  const identity = await loadBrowserDeviceIdentity(userId);
  if (identity === null) {
    writeMarker(userId, { status: "revoked", publicKey: expectedPublicKey });
    return "revoked";
  }
  if (identity.publicKeyWire !== expectedPublicKey) {
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

/**
 * A first guess at what to call this device, so the list is navigable before
 * anyone renames anything.
 *
 * Recognition only. This is sent to the server, stored there, and editable
 * there, so it must never be what an operator verifies -- a hostile server can
 * set any label it likes. The fingerprint remains the comparison value.
 */
export function defaultDeviceLabel(): string | null {
  const agent = globalThis.navigator?.userAgent ?? "";
  if (agent === "") return null;
  const platform = /iPhone/u.test(agent)
    ? "iPhone"
    : /iPad/u.test(agent)
      ? "iPad"
      : /Android/u.test(agent)
        ? "Android"
        : /Macintosh|Mac OS/u.test(agent)
          ? "Mac"
          : /Windows/u.test(agent)
            ? "Windows"
            : /Linux/u.test(agent)
              ? "Linux"
              : null;
  const browser = /EdgA?\//u.test(agent)
    ? "Edge"
    : /OPR\//u.test(agent)
      ? "Opera"
      : /Firefox\//u.test(agent)
        ? "Firefox"
        : /CriOS|Chrome\//u.test(agent)
          ? "Chrome"
          : /Safari\//u.test(agent)
            ? "Safari"
            : null;
  if (platform === null && browser === null) return null;
  return [browser, platform]
    .filter((part) => part !== null)
    .join(" on ")
    .slice(0, 64);
}

async function registerBrowserDevice(
  userId: string,
  replacedRevokedKey = false,
): Promise<BrowserDeviceRegistrationState> {
  // A removal is not a dead end for the browser it happened to: the removed
  // KEY stays dead for good (R10), and this signed-in browser simply becomes
  // a new, unapproved device — visible in every roster, waiting for approval
  // (R4). No button, no ceremony to get *here*; the ceremony guards approval,
  // never presence. Finish any interrupted cleanup, drop the marker, and fall
  // through to minting a fresh identity.
  let marker = readBrowserDeviceRevocationMarker(userId);
  if (marker?.status === "cleanup_pending") {
    try {
      await finishBrowserDeviceLocalCleanup(userId, marker.publicKey);
    } catch {
      // The dead key could not be deleted locally; surface that explicitly
      // rather than minting a second identity next to it.
      return { status: "cleanup_pending", publicKey: marker.publicKey };
    }
    marker = readBrowserDeviceRevocationMarker(userId);
  }
  if (marker?.status === "revoked") {
    allowExplicitBrowserIdentityReplacement(userId, marker.publicKey);
  }

  // Inside the desktop app's window this page IS the app's device: the app
  // leaves its identity on the way in, and it replaces whatever this page
  // minted for itself before (desktop-device-handover.ts).
  const carried = takeDesktopDeviceHandover(userId);
  const adopted = carried === null ? null : await adoptBrowserDeviceIdentity(userId, carried);
  const identity = adopted?.identity ?? (await loadOrCreateBrowserDeviceIdentity(userId));
  const signature = await createBrowserDeviceRegistrationProof(identity, userId);
  let device: BrowserDevice;
  try {
    device = await browserDevices.register({
      key_algorithm: "ed25519",
      public_key: identity.publicKeyWire,
      signature,
      label: defaultDeviceLabel(),
    });
  } catch (error) {
    if (isRevokedDeviceKeyRefusal(error) && !replacedRevokedKey) {
      // The server refused this key as revoked: this device was removed FROM
      // ANOTHER device (R1), and this is the moment it finds out. Clean up the
      // dead key and register a fresh one in the same pass — seamlessly, the
      // way any unapproved sign-in appears. Guarded to a single replacement:
      // a server refusing the brand-new key too is an error worth seeing.
      const status = await beginBrowserDeviceLocalCleanup(userId, identity.publicKeyWire);
      if (status === "cleanup_pending") {
        await finishBrowserDeviceLocalCleanup(userId, identity.publicKeyWire);
      }
      const cleared = readBrowserDeviceRevocationMarker(userId);
      if (cleared?.status === "revoked") {
        allowExplicitBrowserIdentityReplacement(userId, cleared.publicKey);
      }
      return registerBrowserDevice(userId, true);
    }
    throw error;
  }
  // The response carries the key alone (mesh B5); the exact-key comparison is
  // the whole check, and any fingerprint shown for this device is derived
  // locally from the key.
  if (
    device.key_algorithm !== "ed25519" ||
    device.public_key !== identity.publicKeyWire ||
    device.revoked_at !== null
  ) {
    throw new Error("browser registration response did not match the submitted active key");
  }
  if (adopted?.replacedPublicKeyWire) {
    void retireSupersededDevice(adopted.replacedPublicKeyWire, device.id);
  }
  if (replacedRevokedKey) {
    // Registration restored presence, not trust. Raise the approval request
    // immediately even when the browser healed on a safe route; the shell's
    // pending badge and registration banner then make the next step visible.
    try {
      await Promise.all([
        browserDevices.requestApproval(device.id, device.public_key),
        trust.requestDeviceApproval(device.id),
      ]);
    } catch (cause) {
      console.warn(
        "SPAWN D replaced a revoked browser identity, but could not request approval:",
        cause instanceof Error ? cause.message : cause,
      );
    }
  }
  return {
    status: "ready",
    device,
    publicKey: identity.publicKeyWire,
    recoveredFromRevocation: replacedRevokedKey || undefined,
  };
}

/**
 * New servers name the permanent refusal. The message fallback is restricted
 * to old servers whose generic `http_409` is the only discriminator they had.
 */
export function isRevokedDeviceKeyRefusal(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code === "device_key_revoked" ||
      (error.code === "http_409" && /revoked/iu.test(error.message)))
  );
}

/**
 * Revoke the roster row of the key this page just stopped being: a device
 * nobody can use any more, which would otherwise sit in every roster as a
 * stranger waiting to be approved. Best effort — the row is cosmetic once
 * its key is gone from here — and never the account root, which only a
 * passkey ceremony may replace.
 */
async function retireSupersededDevice(publicKey: string, revokedByDeviceId: string): Promise<void> {
  try {
    const rows = await browserDevices.list();
    const row = rows.find(
      (device) => device.public_key === publicKey && device.revoked_at === null,
    );
    if (row === undefined || row.is_root) return;
    await browserDevices.revoke(row.id, publicKey, revokedByDeviceId);
  } catch (cause) {
    console.warn(
      "spawn: the device this page used to be could not be retired:",
      cause instanceof Error ? cause.message : cause,
    );
  }
}

export function browserIdentityConnectionsAllowed(
  state: BrowserDeviceRegistrationState | undefined,
): boolean {
  return state?.status === "ready";
}

/**
 * Why registration failed, said in a way the reader can do something about.
 *
 * Every failure used to read the same line — registration failed, reload to
 * retry — which is true of a dropped request and a flat lie about a browser
 * that cannot make the key at all, or a saved key that has become unreadable.
 * Reloading those runs the same code into the same wall for ever, and the one
 * sentence on screen is the only place a reader can learn otherwise.
 *
 * The cause is separated from the remedy so each surface can put its own
 * consequence between them, and `canRetry` says whether running registration
 * again could plausibly land differently.
 */
export interface BrowserDeviceRegistrationFailure {
  /** What went wrong, as a complete sentence. */
  readonly reason: string;
  /** What would change it, where anything the reader controls would. */
  readonly remedy: string | null;
  /** Whether registering again could succeed without the reader doing anything. */
  readonly canRetry: boolean;
}

export function describeBrowserDeviceRegistrationFailure(
  error: unknown,
): BrowserDeviceRegistrationFailure {
  if (error instanceof CryptoUnavailableError) {
    return {
      reason: "This browser cannot create the Ed25519 key SPAWN D signs with.",
      remedy: "A current Chrome, Safari, Edge or Firefox can.",
      canRetry: false,
    };
  }
  if (error instanceof BrowserDeviceIdentityError) {
    switch (error.code) {
      case "storage_unavailable":
        return {
          reason: "This browser has nowhere to keep SPAWN D's key.",
          remedy: "A private window, or site data turned off for this site, does that.",
          canRetry: false,
        };
      case "storage_failure":
        return {
          reason: "This browser could not save SPAWN D's key.",
          remedy: null,
          canRetry: true,
        };
      case "corrupt_record":
        return {
          reason: "The key this browser saved for SPAWN D is unreadable.",
          remedy: "Clearing this site's data lets it mint a new one.",
          canRetry: false,
        };
      case "capacity_exceeded":
        return {
          reason: "This browser is holding keys for too many accounts.",
          remedy: "Clearing this site's data lets it mint a new one.",
          canRetry: false,
        };
      case "invalid_account":
      case "key_mismatch":
        return {
          reason: "The key this browser holds does not belong to this account.",
          remedy: null,
          canRetry: false,
        };
    }
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "device_key_revoked":
        return {
          reason: "The server permanently refused this device key because it was removed.",
          remedy: "SPAWN D must create a fresh identity before this device can be approved again.",
          canRetry: false,
        };
      case "device_key_owned_by_other_account":
        return {
          reason: "This device key already belongs to another account.",
          remedy: "Clear this site's data before signing in to this account again.",
          canRetry: false,
        };
      case "root_designation_mismatch":
        return {
          reason: "The server refused a different root designation for this device key.",
          remedy: "Open Access and use the account recovery flow instead of registering again.",
          canRetry: false,
        };
      case "root_already_exists":
        return {
          reason: "This account already has a different passkey root.",
          remedy: "Open Access and use that passkey to recover this device.",
          canRetry: false,
        };
      case "registration_proof_invalid":
        return {
          reason: "The server could not verify this browser's registration proof.",
          remedy: null,
          canRetry: false,
        };
    }
    return {
      reason: `The server refused this browser's identity: ${error.message}`,
      remedy: null,
      // A refusal on the merits stays a refusal; only an overloaded or broken
      // server is worth asking again.
      canRetry: error.status >= 500 || error.status === 429,
    };
  }
  return {
    reason: "This browser's identity could not be registered.",
    remedy: null,
    canRetry: true,
  };
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
    // Registration is the reconcile: it stamps last-seen and is the moment a
    // device discovers it was removed elsewhere (409-revoked → seamless key
    // replacement). Long-lived pages must keep having that moment — a page
    // that registers once and never again retries dead keys forever. Focus
    // and a slow interval keep every open page honest within ~a minute.
    staleTime: 30_000,
    refetchInterval: 90_000,
    refetchOnWindowFocus: "always",
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
