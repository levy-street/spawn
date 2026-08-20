"use client";

/**
 * Passkey setup, offered before anything else on the first device
 * (DESIGN.md §5.1), and the no-passkey cost sheet (§5.6) — a contract the
 * user affirms, listing every documented cost of running without recovery.
 */

import { useState } from "react";
import { Btn, Card, CeremonyOutcome, Muted, Spinner } from "./bits";
import type { PasskeyOnboardingState } from "./types";

export interface PasskeyOnboardingProps {
  state: PasskeyOnboardingState;
  onCreatePasskey: () => void;
  onSkip: () => void;
  onAcceptLockoutRisk: () => void;
  onBackToCreate: () => void;
  onContinue: () => void;
}

export function PasskeyOnboarding({
  state,
  onCreatePasskey,
  onSkip,
  onAcceptLockoutRisk,
  onBackToCreate,
  onContinue,
}: PasskeyOnboardingProps) {
  const [acknowledged, setAcknowledged] = useState(false);

  switch (state.step) {
    case "offer":
      return (
        <Card>
          <h3 className="font-semibold text-neutral-900">Create a passkey</h3>
          <p className="mt-1 text-sm text-neutral-700">
            It backs every device and host you add, and it&apos;s how you get back in if you lose
            everything. You&apos;ll almost never be asked for it.
          </p>
          <div className="mt-3 flex gap-2">
            <Btn kind="primary" onClick={onCreatePasskey}>
              Create passkey
            </Btn>
            <Btn kind="quiet" onClick={onSkip}>
              Skip for now
            </Btn>
          </div>
          <div className="mt-2">
            <Muted>
              Signing in identifies you to the service. Your devices decide what to trust.
            </Muted>
          </div>
        </Card>
      );

    case "creating":
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

    case "done":
      return (
        <CeremonyOutcome
          tone="ok"
          title="Passkey created"
          body="This device is backed by it, and every device and host you add will be too — automatically."
          actions={
            <Btn kind="primary" onClick={onContinue}>
              Pair your first host
            </Btn>
          }
        />
      );

    case "cost-sheet":
      return (
        <Card tone="danger">
          <h3 className="font-semibold text-neutral-900">Without a passkey</h3>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-neutral-700">
            <li>
              Lose all your devices and you are locked out of every host. The only way back is at
              each machine&apos;s keyboard.
            </li>
            <li>New devices always require another device present to approve them.</li>
            <li>
              A host paired from one device may not be reachable from your others until you re-link
              those devices.
            </li>
            <li>Keep at least two linked devices at all times.</li>
          </ul>
          <label className="mt-3 flex items-start gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5"
            />
            I accept the lockout risk.
          </label>
          <div className="mt-3 flex gap-2">
            <Btn kind="primary" onClick={onBackToCreate}>
              Create a passkey instead
            </Btn>
            <Btn kind="danger-quiet" onClick={onAcceptLockoutRisk} disabled={!acknowledged}>
              Continue without one
            </Btn>
          </div>
        </Card>
      );

    case "error":
      return (
        <CeremonyOutcome
          tone="warn"
          title="Passkey creation didn't finish"
          body={`${state.message} You can try again, or skip for now — the option stays on your Security page.`}
          actions={
            <>
              <Btn kind="primary" onClick={onCreatePasskey}>
                Try again
              </Btn>
              <Btn kind="quiet" onClick={onSkip}>
                Skip for now
              </Btn>
            </>
          }
        />
      );
  }
}
