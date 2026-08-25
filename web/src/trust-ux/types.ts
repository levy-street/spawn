export type DeviceKind = "phone" | "laptop";

/** One row in the device roster. `provenance` is the R4 audit surface in plain words. */
export interface DeviceVM {
  id: string;
  name: string;
  kind: DeviceKind;
  isThisDevice?: boolean;
  /** "Approved by MacBook Pro · Jun 3" | "First device" | "Approved by your passkey · Jul 2"
      — or, while waiting, "Signed in 2m ago". */
  provenance: string;
  /** "Now" | "2h ago" | "Jun 12" */
  lastSeen: string;
  /** Present only when the server last saw this live device more than 60 days ago. */
  staleLabel?: string;
  /** Signed in but not yet approved: visible immediately (R4), amber, with Approve. */
  waiting?: boolean;
}

export interface HostVM {
  id: string;
  name: string;
  /** "Possessed by MacBook Pro · May 28" */
  provenance: string;
  online: boolean;
}

export type TrustEventKind = "approved" | "removed" | "passkey";

/** One line of the trust log (R4): plain sentence + when. */
export interface TrustEventVM {
  id: string;
  text: string;
  when: string;
  kind: TrustEventKind;
}

/**
 * The number check (committed SAS, A5). One component serves both ceremonies:
 * approving a device and possessing a host.
 */
export type CeremonyPhase = "connecting" | "compare" | "waiting" | "done" | "stopped";
