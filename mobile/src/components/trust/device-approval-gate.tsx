import { useCallback, useEffect, useRef, useState } from "react";

import { DeviceApprovalOverlay } from "@/components/trust/device-approval-overlay";
import { invalidateDeviceHostTrust, probeDeviceHostTrust } from "@/data/trust/device-trust";
import { useHostApprovalWatch } from "@/data/trust/use-host-approval-watch";

export interface DeviceApprovalGate {
  /**
   * Run `action` once this device may actually reach `hostId`: straight away if
   * the host already trusts it, otherwise after the approval ceremony lands.
   */
  guard: (hostId: string, action: () => void) => void;
  /** Render this inside the screen that owns the gate. */
  overlay: React.JSX.Element | null;
}

/**
 * Ask for the device's approval *before* the thing that needs it, not after it
 * fails.
 *
 * Everything a phone does on a host — open a terminal, list a folder, create a
 * workspace in one — needs that host to have approved this device. Discovering
 * that halfway through a flow means an error where the answer should have been,
 * so a surface that is about to need it puts the ceremony first and then carries
 * on by itself. The action runs when the sheet closes rather than the instant
 * trust lands: the ceremony holds its "approved" for a beat, and opening the
 * next screen underneath it would throw that away.
 */
export function useDeviceApprovalGate(): DeviceApprovalGate {
  // The host is kept after the sheet closes so the closing animation still has
  // one; a new guard replaces it.
  const [hostId, setHostId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const action = useRef<(() => void) | null>(null);
  const approved = useRef(false);

  const guard = useCallback((host: string, run: () => void) => {
    void (async () => {
      // The verdict changes elsewhere — on a laptop, seconds ago — so a
      // memoized one is exactly what this must not act on.
      invalidateDeviceHostTrust(host);
      const trust = await probeDeviceHostTrust(host).catch(() => "unknown" as const);
      // "unknown" is a probe that could not answer, not a refusal: never hold
      // an action hostage to a question nobody could answer.
      if (trust !== "untrusted") {
        run();
        return;
      }
      action.current = run;
      approved.current = false;
      setHostId(host);
      setOpen(true);
    })();
  }, []);

  const trust = useHostApprovalWatch(hostId ?? undefined, open);
  useEffect(() => {
    if (open && trust === "trusted") approved.current = true;
  }, [open, trust]);

  const close = useCallback(() => {
    setOpen(false);
    const run = action.current;
    action.current = null;
    if (approved.current) run?.();
    approved.current = false;
  }, []);

  return {
    guard,
    overlay:
      hostId === null ? null : (
        <DeviceApprovalOverlay hostId={hostId} onDismiss={close} visible={open} />
      ),
  };
}
