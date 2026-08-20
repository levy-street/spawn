"use client";

/**
 * Recovery after total device loss (DESIGN.md §5.4).
 * With a passkey: one unlock restores everything — the unlock IS the human
 * check. Without one: the honest lockout (R8) with per-machine re-pairing as
 * the only path back.
 */

import { Btn, Card, CeremonyOutcome, Spinner } from "./bits";
import type { RecoveryState } from "./types";

export interface RecoveryFlowProps {
  state: RecoveryState;
  onUnlockWithPasskey: () => void;
  onShowPairingInstructions: (hostName: string) => void;
  onDone: () => void;
  onRetry: () => void;
}

export function RecoveryFlow({
  state,
  onUnlockWithPasskey,
  onShowPairingInstructions,
  onDone,
  onRetry,
}: RecoveryFlowProps) {
  switch (state.step) {
    case "intro":
      return (
        <Card>
          <h3 className="font-semibold text-neutral-900">Welcome back</h3>
          <p className="mt-1 text-sm text-neutral-700">
            Unlock with your passkey to restore access to your {state.hostCount}{" "}
            {state.hostCount === 1 ? "host" : "hosts"} on this device.
          </p>
          <div className="mt-3">
            <Btn kind="primary" onClick={onUnlockWithPasskey}>
              Unlock with passkey
            </Btn>
          </div>
        </Card>
      );

    case "unlocking":
      return (
        <Card>
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-sm text-neutral-700">
              Follow your browser&apos;s passkey prompt…
            </span>
          </div>
        </Card>
      );

    case "restoring":
      return (
        <Card>
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-sm text-neutral-700">Restoring your account on this device…</span>
          </div>
        </Card>
      );

    case "restored":
      return (
        <CeremonyOutcome
          tone="ok"
          title="Restored"
          body={`This device is backed by your passkey. ${state.hostCount} ${
            state.hostCount === 1 ? "host is" : "hosts are"
          } available.`}
          actions={
            <Btn kind="primary" onClick={onDone}>
              Continue
            </Btn>
          }
        />
      );

    case "lockout":
      return (
        <Card tone="danger">
          <h3 className="font-semibold text-neutral-900">There is no remote way back in</h3>
          <p className="mt-1 text-sm text-neutral-700">
            That&apos;s the design: nothing but your devices could grant access, and they&apos;re
            gone. To reconnect, go to each machine and pair it again.
          </p>
          <div className="mt-3 space-y-2">
            {state.hostNames.map((h) => (
              <div
                key={h}
                className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2"
              >
                <span className="text-sm font-medium text-neutral-900">{h}</span>
                <Btn kind="quiet" onClick={() => onShowPairingInstructions(h)}>
                  Pairing instructions
                </Btn>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            A passkey would have avoided this. You can create one after you&apos;re back in.
          </p>
        </Card>
      );

    case "error":
      return (
        <CeremonyOutcome
          tone="warn"
          title="Restore didn't finish"
          body={`${state.message} Nothing changed; it's safe to try again.`}
          actions={
            <Btn kind="primary" onClick={onRetry}>
              Try again
            </Btn>
          }
        />
      );
  }
}
