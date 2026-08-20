"use client";

/**
 * "Approve a device" — the trusted device's side of linking (DESIGN.md §5.3).
 *
 * The requester's name/platform are labeled as unverified claims; the typed
 * code is what proves the device is the user's (A5 entry-style — the trusted
 * side always types, never taps approve).
 */

import { Btn, Card, CeremonyOutcome, CodeEntry, Spinner } from "./bits";
import type { LinkDeviceApproveState } from "./types";

export interface LinkDeviceApproveProps {
  state: LinkDeviceApproveState;
  onContinue: () => void;
  onDismiss: () => void;
  onSubmitCode: (code: string) => void;
  onReportMismatch: () => void;
  onDone: () => void;
}

export function LinkDeviceApprove({
  state,
  onContinue,
  onDismiss,
  onSubmitCode,
  onReportMismatch,
  onDone,
}: LinkDeviceApproveProps) {
  switch (state.step) {
    case "incoming":
      return (
        <Card>
          <h3 className="font-semibold text-neutral-900">A device wants to join your account</h3>
          <p className="mt-1 text-sm text-neutral-700">
            A device calling itself &quot;{state.requester.claimedName}&quot; (
            {state.requester.claimedPlatform}) asked to join at {state.requester.requestedAt}.
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            The name and platform are the device&apos;s own claim. The code check is what proves
            it&apos;s yours.
          </p>
          <div className="mt-3 flex gap-2">
            <Btn kind="primary" onClick={onContinue}>
              Continue
            </Btn>
            <Btn kind="quiet" onClick={onDismiss}>
              Not now
            </Btn>
          </div>
        </Card>
      );

    case "enter-code":
      return (
        <Card>
          <h3 className="font-semibold text-neutral-900">
            Confirm &quot;{state.requester.claimedName}&quot;
          </h3>
          <div className="mt-3">
            <CodeEntry
              otherSideLabel={`the new device ("${state.requester.claimedName}")`}
              attemptsRemaining={state.attemptsRemaining}
              wrongEntry={state.wrongEntry}
              onSubmitCode={onSubmitCode}
              onReportMismatch={onReportMismatch}
            />
          </div>
        </Card>
      );

    case "verifying":
      return (
        <Card>
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-sm text-neutral-700">Verifying…</span>
          </div>
        </Card>
      );

    case "approved":
      return (
        <CeremonyOutcome
          tone="ok"
          title={`${state.deviceName} linked`}
          body={
            state.backedByPasskey
              ? `It can now reach all ${state.hostCount} hosts and is backed by your passkey.`
              : `It can now reach all ${state.hostCount} hosts, vouched for by this device. It will be backed by your passkey the next time you use one.`
          }
          actions={
            <Btn kind="primary" onClick={onDone}>
              Done
            </Btn>
          }
        />
      );

    case "mismatch-reported":
      return (
        <CeremonyOutcome
          tone="danger"
          title="Stopped — the codes didn't match"
          body="Nothing was trusted, and this attempt has been recorded in your trust history. A mismatch can mean something interfered between your devices. If it happens again, stop and try from a different network."
          actions={
            <Btn kind="quiet" onClick={onDone}>
              Close
            </Btn>
          }
        />
      );

    case "attempts-exhausted":
      return (
        <CeremonyOutcome
          tone="danger"
          title="Stopped after three attempts"
          body="Nothing was trusted. If the two screens really show different codes, something may be interfering. To try again, start a new link from the other device — it will get a fresh code."
          actions={
            <Btn kind="quiet" onClick={onDone}>
              Close
            </Btn>
          }
        />
      );

    case "expired":
      return (
        <CeremonyOutcome
          tone="neutral"
          title="This request expired"
          body="The code is short-lived on purpose. Ask the new device to start again."
          actions={
            <Btn kind="quiet" onClick={onDone}>
              Close
            </Btn>
          }
        />
      );

    case "error":
      return (
        <CeremonyOutcome
          tone="warn"
          title="Couldn't reach the service"
          body={`${state.message} Nothing was trusted; it's safe to try again.`}
          actions={
            <Btn kind="quiet" onClick={onDone}>
              Close
            </Btn>
          }
        />
      );
  }
}
