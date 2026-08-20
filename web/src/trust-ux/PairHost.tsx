"use client";

/**
 * "Pair a host" — the browser side of the host↔browser anchor ceremony
 * (DESIGN.md §5.2). The terminal displays the code; the browser types it.
 * Includes the legacy-host full-fingerprint fallback — the one place a compare
 * without typing is permitted, because the value is full-entropy (A5 corollary).
 */

import { Btn, Card, CeremonyOutcome, CodeEntry, Spinner } from "./bits";
import type { PairHostState } from "./types";

export interface PairHostProps {
  state: PairHostState;
  onCopyCommand: (command: string) => void;
  onCancel: () => void;
  onStartOver: () => void;
  onSubmitCode: (code: string) => void;
  onReportMismatch: () => void;
  onFingerprintsMatch: () => void;
  onFingerprintsDiffer: () => void;
  onDone: () => void;
}

export function PairHost({
  state,
  onCopyCommand,
  onCancel,
  onStartOver,
  onSubmitCode,
  onReportMismatch,
  onFingerprintsMatch,
  onFingerprintsDiffer,
  onDone,
}: PairHostProps) {
  switch (state.step) {
    case "instructions":
      return (
        <Card>
          <h3 className="font-semibold text-neutral-900">Pair a host</h3>
          <p className="mt-1 text-sm text-neutral-700">
            Run this on the machine you want to reach. It will print a 6-digit code.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-sm text-neutral-800">
            {state.command}
          </pre>
          <div className="mt-3 flex gap-2">
            <Btn kind="primary" onClick={() => onCopyCommand(state.command)}>
              Copy command
            </Btn>
            <Btn kind="quiet" onClick={onCancel}>
              Cancel
            </Btn>
          </div>
        </Card>
      );

    case "waiting-for-host":
      return (
        <Card>
          <div className="flex items-center gap-2">
            <Spinner />
            <h3 className="font-semibold text-neutral-900">Waiting for the host</h3>
          </div>
          <p className="mt-2 text-sm text-neutral-700">
            Once the command runs, the machine will appear here and its terminal will print the
            code.
          </p>
          <div className="mt-3">
            <Btn kind="quiet" onClick={onCancel}>
              Cancel
            </Btn>
          </div>
        </Card>
      );

    case "enter-code":
      return (
        <Card>
          <h3 className="font-semibold text-neutral-900">Confirm {state.hostName}</h3>
          <div className="mt-3">
            <CodeEntry
              otherSideLabel={`the terminal on "${state.hostName}"`}
              attemptsRemaining={state.attemptsRemaining}
              wrongEntry={state.wrongEntry}
              onSubmitCode={onSubmitCode}
              onReportMismatch={onReportMismatch}
            />
          </div>
        </Card>
      );

    case "fingerprint-fallback":
      return (
        <Card tone="warn">
          <h3 className="font-semibold text-neutral-900">
            Compare the full fingerprint for {state.hostName}
          </h3>
          <p className="mt-1 text-sm text-neutral-700">
            This host is running an older version, so pairing uses the full fingerprint instead of a
            short code. Compare it with the one printed in the terminal — every group must match.
          </p>
          <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-center font-mono text-lg tracking-wider break-all text-neutral-900">
            {state.fingerprintGroups.join(" ")}
          </div>
          <div className="mt-3 flex gap-2">
            <Btn kind="primary" onClick={onFingerprintsMatch}>
              Every group matches
            </Btn>
            <Btn kind="danger-quiet" onClick={onFingerprintsDiffer}>
              They don&apos;t match
            </Btn>
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

    case "paired":
      return (
        <CeremonyOutcome
          tone="ok"
          title={`${state.hostName} paired`}
          body={
            state.backedByPasskey
              ? "Your passkey now backs it — every device you link can reach it, and losing this browser won't lose the host."
              : "Paired with this device. Only devices linked to your account can reach it. Without a passkey, losing this device means pairing the host again at the machine."
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
          body="Nothing was trusted, and this attempt has been recorded in your trust history. If this happens again on the same network, something may be interfering between you and the machine."
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
          body="Nothing was trusted. Run the pairing command on the machine again to get a fresh code."
          actions={
            <Btn kind="quiet" onClick={onStartOver}>
              Start over
            </Btn>
          }
        />
      );

    case "expired":
      return (
        <CeremonyOutcome
          tone="neutral"
          title="This code expired"
          body="Codes are short-lived on purpose. Run the pairing command on the machine again."
          actions={
            <Btn kind="primary" onClick={onStartOver}>
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
