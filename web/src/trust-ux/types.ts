export type DeviceKind = "phone" | "laptop";

/** One row in the device roster. `provenance` is the R4 audit surface in plain words. */
export interface DeviceVM {
  id: string;
  name: string;
  kind: DeviceKind;
  isThisDevice?: boolean;
  /** "Linked by MacBook Pro · Jun 3" | "First device" | "Added by recovery · Jul 2" */
  provenance: string;
  /** "Now" | "2h ago" | "Jun 12" */
  lastSeen: string;
}

export interface MachineVM {
  id: string;
  name: string;
  /** "Possessed by MacBook Pro · May 28" */
  provenance: string;
  online: boolean;
}

export type TrustEventKind = "added" | "removed" | "recovery";

/** One line of the trust log (R4): plain sentence + when. */
export interface TrustEventVM {
  id: string;
  text: string;
  when: string;
  kind: TrustEventKind;
}

export type RecoveryVM = { on: true; detail: string } | { on: false };

/**
 * The number check (committed SAS, A5). One component serves both ceremonies:
 * linking a device and connecting a computer.
 */
export type CeremonyPhase = "connecting" | "compare" | "waiting" | "done" | "stopped";
