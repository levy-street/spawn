/**
 * spawn trust UX — data and state-machine types.
 *
 * These are pure view-model types: everything a component renders arrives through
 * these shapes, and every action leaves through a callback prop. No fetching, no
 * app imports. See DESIGN.md for the vocabulary these types encode.
 */

export type DeviceId = string;
export type HostId = string;

/** How a device entered the account — the audit sentence on its roster row. */
export type DeviceProvenance =
  | { kind: "first-device" }
  | { kind: "linked"; byDeviceName: string; at: string }
  | { kind: "restored-by-passkey"; at: string };

export interface TrustDevice {
  id: DeviceId;
  name: string;
  platform: string;
  isThisDevice: boolean;
  addedAt: string;
  lastSeenAt?: string;
  provenance: DeviceProvenance;
  /** Root-endorsed (steady state). */
  backedByPasskey: boolean;
  /** Chain parent when not passkey-backed. */
  vouchedForBy?: { deviceId: DeviceId; deviceName: string };
  /** Hosts whose only key this device is (R5 pre-warning). */
  soleKeyForHosts: string[];
}

export type HostTrustStatus =
  | { kind: "backed-by-passkey"; alsoPairedWith: string[] }
  | { kind: "paired-only"; deviceNames: string[] }
  | { kind: "orphaned"; formerDeviceName: string };

export interface TrustHost {
  id: HostId;
  name: string;
  online: boolean;
  status: HostTrustStatus;
  /** A removal is queued for this host until it next comes online (P3 wording). */
  pendingRemovalApplies?: boolean;
}

/** Trust history events (R4). Newest first. */
export type TrustEvent =
  | { id: string; at: string; kind: "device-linked"; deviceName: string; approvedBy: string }
  | { id: string; at: string; kind: "passkey-backed-device"; deviceName: string }
  | { id: string; at: string; kind: "passkey-backed-host"; hostName: string }
  | { id: string; at: string; kind: "host-paired"; hostName: string; byDeviceName: string }
  | { id: string; at: string; kind: "device-removed"; deviceName: string; byDeviceName: string }
  | { id: string; at: string; kind: "link-mismatch-stopped" }
  | { id: string; at: string; kind: "link-expired" }
  | { id: string; at: string; kind: "account-restored"; deviceName: string }
  | { id: string; at: string; kind: "passkey-created" }
  | { id: string; at: string; kind: "passkey-trust-reset"; orphanedHostNames: string[] };

export type TrustWarning =
  | { kind: "no-passkey" }
  | { kind: "single-device-no-passkey" }
  | { kind: "sole-key-host"; hostName: string; deviceName: string }
  | { kind: "awaiting-passkey-backup"; deviceCount: number }
  | { kind: "new-device-nudge"; deviceName: string; addedAt: string };

export type PasskeyStatus = { state: "active"; createdAt: string } | { state: "none" };

/* ------------------------------------------------------------------ */
/* Ceremony state machines                                             */
/* ------------------------------------------------------------------ */

/** Joining device side of "link a device" (DESIGN.md §5.3). */
export type LinkDeviceNewState =
  | { step: "choose"; passkeyAvailable: boolean; hostCount: number }
  | { step: "waiting-for-approver" }
  | { step: "showing-code"; code: string; approverName?: string; expiresInSeconds: number }
  | { step: "linked"; approverName: string; backedByPasskey: boolean; hostCount: number }
  | { step: "declined" }
  | { step: "expired" }
  | { step: "integrity-failure" }
  | { step: "error"; message: string };

export interface RequesterClaims {
  claimedName: string;
  claimedPlatform: string;
  requestedAt: string;
}

/** Trusted (approving) device side of "link a device". */
export type LinkDeviceApproveState =
  | { step: "incoming"; requester: RequesterClaims }
  | {
      step: "enter-code";
      requester: RequesterClaims;
      attemptsRemaining: number;
      wrongEntry: boolean;
    }
  | { step: "verifying" }
  | { step: "approved"; deviceName: string; backedByPasskey: boolean; hostCount: number }
  | { step: "mismatch-reported" }
  | { step: "attempts-exhausted" }
  | { step: "expired" }
  | { step: "error"; message: string };

/** Browser side of "pair a host" (DESIGN.md §5.2). */
export type PairHostState =
  | { step: "instructions"; command: string }
  | { step: "waiting-for-host" }
  | { step: "enter-code"; hostName: string; attemptsRemaining: number; wrongEntry: boolean }
  | { step: "fingerprint-fallback"; hostName: string; fingerprintGroups: string[] }
  | { step: "verifying" }
  | { step: "paired"; hostName: string; backedByPasskey: boolean }
  | { step: "mismatch-reported" }
  | { step: "attempts-exhausted" }
  | { step: "expired" }
  | { step: "error"; message: string };

/** Passkey setup incl. the no-passkey cost sheet (DESIGN.md §5.1, §5.6). */
export type PasskeyOnboardingState =
  | { step: "offer" }
  | { step: "creating" }
  | { step: "done" }
  | { step: "cost-sheet" }
  | { step: "error"; message: string };

/** Recovery after total loss (DESIGN.md §5.4). */
export type RecoveryState =
  | { step: "intro"; hostCount: number }
  | { step: "unlocking" }
  | { step: "restoring" }
  | { step: "restored"; hostCount: number }
  | { step: "lockout"; hostNames: string[] }
  | { step: "error"; message: string };

/* ------------------------------------------------------------------ */
/* Revocation dialogs                                                  */
/* ------------------------------------------------------------------ */

export interface CollateralDevice {
  deviceName: string;
  /** True when a passkey exists: access returns at the next passkey use (P3''). */
  restoredByNextPasskeyUse: boolean;
}

export interface RemoveDeviceConsequences {
  onlineHostCount: number;
  offlineHostCount: number;
  hasLiveSessions: boolean;
  /** Hosts orphaned by this removal (R5). */
  orphanedHostNames: string[];
  /** Devices whose only trust path runs through the removed device. */
  collateralDevices: CollateralDevice[];
}

/* ------------------------------------------------------------------ */
/* Connection gate (DESIGN.md §5.7)                                    */
/* ------------------------------------------------------------------ */

export type ConnectionRefusal =
  | { kind: "device-removed"; removedAt: string; removedByDeviceName: string }
  | { kind: "session-ended-removed" }
  | { kind: "trust-path-broken"; throughDeviceName: string; passkeyAvailable: boolean }
  | { kind: "host-orphaned"; hostName: string }
  | { kind: "host-added-elsewhere"; hostName: string; pairingDeviceName: string };

/** Basis line for the session verified chip. */
export type VerifiedBasis = { kind: "passkey" } | { kind: "device"; deviceName: string };
