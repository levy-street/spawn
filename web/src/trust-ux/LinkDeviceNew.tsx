"use client";

/**
 * "Link this device" — the joining device's side (DESIGN.md §5.3).
 *
 * Passkey-first fork: with a passkey, admission is the passkey unlock itself
 * (the heal backs the device directly — no number ceremony). The committed-SAS
 * ceremony is the fallback for no-passkey accounts and passkey-less hardware.
 * This side DISPLAYS the code; the trusted side types it (A5 entry-style).
 */

import { Btn, Card, CeremonyOutcome, MatchCode, Muted, Spinner } from "./bits";
import type { LinkDeviceNewState } from "./types";

export interface LinkDeviceNewProps {
  state: LinkDeviceNewState;
  onUsePasskey: () => void;
  onStartApproval: () => void;
  onCancel: () => void;
  onStartOver: () => void;
  onDone: () => void;
}

export function LinkDeviceNew({
  state,
  onUsePasskey,
  onStartApproval,
  onCancel,
  onStartOver,
  onDone,
}: LinkDeviceNewProps) {
  switch (state.step) {
    case "choose":
      return (
        <Card>
          <h3 className="font-semibold text-neutral-900">Link this device</h3>
          <p className="mt-1 text-sm text-neutral-700">
            This device isn&apos;t linked to your account yet. Signing in identifies you to the
            service — your devices decide what to trust.
          </p>
          <div className="mt-3 space-y-2">
            {state.passkeyAvailable ? (
              <>
                <Btn kind="primary" onClick={onUsePasskey}>
                  Use your passkey
                </Btn>
                <Muted>
                  Fastest: your passkey backs this device directly. All {state.hostCount} hosts
                  become available.
                </Muted>
                <Btn kind="quiet" onClick={onStartApproval}>
                  Approve from another device instead
                </Btn>
              </>
            ) : (
              <>
                <Btn kind="primary" onClick={onStartApproval}>
                  Approve from another device
                </Btn>
                <Muted>
                  Open spawn on a device you already use, and confirm a short code between the two
                  screens.
                </Muted>
              </>
            )}
          </div>
        </Card>
      );

    case "waiting-for-approver":
      return (
        <Card>
          <div className="flex items-center gap-2">
            <Spinner />
            <h3 className="font-semibold text-neutral-900">Waiting for your other device</h3>
          </div>
          <p className="mt-2 text-sm text-neutral-700">
            Open spawn on a device that&apos;s already linked. An approval request will appear
            there.
          </p>
          <div className="mt-3">
            <Btn kind="quiet" onClick={onCancel}>
              Cancel
            </Btn>
          </div>
        </Card>
      );

    case "showing-code":
      return (
        <Card>
          <h3 className="font-semibold text-neutral-900">Confirm the code</h3>
          <p className="mt-1 text-sm text-neutral-700">
            Enter this code on {state.approverName ?? "your other device"}. If that screen shows a
            different code, stop — don&apos;t enter anything.
          </p>
          <div className="mt-3">
            <MatchCode code={state.code} />
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            This code expires in about {Math.max(1, Math.round(state.expiresInSeconds / 60))}{" "}
            {state.expiresInSeconds >= 90 ? "minutes" : "minute"}. It verifies the two devices to
            each other — it is not a password.
          </p>
          <div className="mt-3">
            <Btn kind="quiet" onClick={onCancel}>
              Cancel
            </Btn>
          </div>
        </Card>
      );

    case "linked":
      return (
        <CeremonyOutcome
          tone="ok"
          title="Linked"
          body={
            <div className="space-y-1">
              <p>
                Approved by {state.approverName}. Every host on the account is available — including
                ones added in the future.
              </p>
              <p>
                {state.backedByPasskey
                  ? "This device is backed by your passkey."
                  : `This device is vouched for by ${state.approverName}. It will be backed by your passkey the next time you use it.`}{" "}
                {state.hostCount} {state.hostCount === 1 ? "host" : "hosts"} available.
              </p>
            </div>
          }
          actions={
            <Btn kind="primary" onClick={onDone}>
              Continue
            </Btn>
          }
        />
      );

    case "declined":
      return (
        <CeremonyOutcome
          tone="danger"
          title="Link stopped on the other device"
          body="The codes didn't match, or the request was declined. Nothing was trusted. If you didn't expect a mismatch, something between your devices may be interfering."
          actions={
            <Btn kind="quiet" onClick={onStartOver}>
              Start over with a new code
            </Btn>
          }
        />
      );

    case "expired":
      return (
        <CeremonyOutcome
          tone="neutral"
          title="This code expired"
          body="Codes are short-lived on purpose. Start again — a fresh code will be generated."
          actions={
            <Btn kind="primary" onClick={onStartOver}>
              Start over
            </Btn>
          }
        />
      );

    case "integrity-failure":
      return (
        <CeremonyOutcome
          tone="danger"
          title="Security check failed"
          body="The check failed before the code was shown. This can indicate interference. Nothing was trusted. If this keeps happening, stop and try from a different network."
          actions={
            <Btn kind="quiet" onClick={onStartOver}>
              Start over
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
            <Btn kind="primary" onClick={onStartOver}>
              Try again
            </Btn>
          }
        />
      );
  }
}
