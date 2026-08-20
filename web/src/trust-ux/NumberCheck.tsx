"use client";

import { useState } from "react";
import { Button, Eyebrow, IconAlert, IconCheck, Screen, Spinner } from "./bits";
import type { CeremonyPhase } from "./types";

export interface NumberCheckProps {
  phase: CeremonyPhase;
  /**
   * Which half of the check this screen is (A5 is entry-style, never
   * tap-to-approve): "show" displays the number and waits; "enter" types the
   * number the other screen is showing.
   */
  mode: "show" | "enter";
  /** "923 579" — displayed in `show` mode. */
  number?: string;
  /**
   * Legacy hosts (older software) have no number; the check falls back to
   * comparing this full fingerprint — never a weaker code. Compare-style.
   */
  fingerprint?: string;
  /** What this ceremony is for: "Link iPhone" / "Possess mac-studio". */
  title: string;
  /** Where the other half is: "on the new device" / "in the host's terminal". */
  otherScreen: string;
  /** One line shown on success: "Linked. Every host is ready." */
  doneText: string;
  /** `enter` mode: wrong-entry feedback, e.g. "That's not it — 2 tries left." */
  entryError?: string;
  /** `waiting`: show a quiet nudge once the caller considers it slow. */
  slowHint?: boolean;
  /** `enter` mode: called with the six digits once all are typed. */
  onSubmit?: (digits: string) => void;
  /** Fingerprint fallback only. */
  onMatch?: () => void;
  /** "I don't see this number" / "They don't match" — always terminal. */
  onNoMatch?: () => void;
  onDone?: () => void;
  onClose?: () => void;
}

/**
 * The one human check in the whole system (the committed SAS of A5). One side
 * shows the number, the other types it — used unchanged for both ceremonies.
 * Mismatch is terminal — there is no "approve anyway".
 */
export function NumberCheck({
  phase,
  mode,
  number,
  fingerprint,
  title,
  otherScreen,
  doneText,
  entryError,
  slowHint = false,
  onSubmit,
  onMatch,
  onNoMatch,
  onDone,
  onClose,
}: NumberCheckProps) {
  const [entered, setEntered] = useState("");

  const submitIfComplete = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setEntered(digits);
    if (digits.length === 6) {
      onSubmit?.(digits);
      setEntered("");
    }
  };

  return (
    <Screen>
      <Eyebrow>{title}</Eyebrow>

      {phase === "connecting" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <Spinner />
          <p className="text-sm text-zinc-400">Securing the connection…</p>
        </div>
      )}

      {phase === "compare" && fingerprint !== undefined && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center">
            <h2 className="text-lg font-medium tracking-tight text-zinc-100">
              Check the fingerprint
            </h2>
            <p className="mt-6 break-all rounded-lg bg-zinc-950 px-4 py-3 text-center font-mono text-base tracking-wide text-zinc-50">
              {fingerprint}
            </p>
            <p className="mt-6 max-w-[26ch] text-balance text-center text-sm leading-relaxed text-zinc-400">
              This host runs older software, so compare its full fingerprint — shown {otherScreen}.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button full onClick={onMatch}>
              They match
            </Button>
            <Button full variant="ghost" onClick={onNoMatch}>
              They don't match
            </Button>
          </div>
        </>
      )}

      {phase === "compare" && fingerprint === undefined && mode === "show" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center">
            <h2 className="text-lg font-medium tracking-tight text-zinc-100">Your number</h2>
            <p className="mt-6 font-mono text-5xl font-semibold tabular-nums tracking-[0.14em] text-zinc-50">
              {number}
            </p>
            <p className="mt-6 max-w-[24ch] text-balance text-center text-sm leading-relaxed text-zinc-400">
              Enter this number {otherScreen}.
            </p>
          </div>
          <div className="flex h-[76px] flex-col items-center justify-center gap-2">
            <div className="flex items-center gap-3 text-sm text-zinc-500">
              <Spinner className="size-4" />
              Waiting for the other side…
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-zinc-600 transition-colors hover:text-zinc-300"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === "compare" && fingerprint === undefined && mode === "enter" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center">
            <h2 className="text-lg font-medium tracking-tight text-zinc-100">Enter the number</h2>
            <input
              value={entered}
              onChange={(event) => submitIfComplete(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000 000"
              aria-label="The six-digit number shown on the other screen"
              className="mt-6 w-[220px] rounded-xl border border-zinc-700 bg-zinc-950 py-3 text-center font-mono text-4xl font-semibold tabular-nums tracking-[0.14em] text-zinc-50 placeholder:text-zinc-800 focus:border-zinc-400 focus:outline-none"
            />
            {entryError !== undefined ? (
              <p className="mt-4 text-sm text-red-400">{entryError}</p>
            ) : (
              <p className="mt-4 max-w-[24ch] text-balance text-center text-sm leading-relaxed text-zinc-400">
                Type the number shown {otherScreen}.
              </p>
            )}
          </div>
          <Button full variant="ghost" onClick={onNoMatch}>
            I don't see a number
          </Button>
        </>
      )}

      {phase === "waiting" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center">
            <h2 className="text-lg font-medium tracking-tight text-zinc-100">Almost there</h2>
            <p className="mt-6 font-mono text-5xl font-semibold tabular-nums tracking-[0.14em] text-zinc-600">
              {number}
            </p>
            <p className="mt-6 max-w-[24ch] text-balance text-center text-sm leading-relaxed text-zinc-400">
              Confirmed here. Finishing up {otherScreen}.
            </p>
          </div>
          <div className="flex h-[76px] flex-col items-center justify-center gap-2 text-sm text-zinc-500">
            <div className="flex items-center gap-3">
              <Spinner className="size-4" />
              Waiting for the other side…
            </div>
            {slowHint && (
              <p className="text-xs text-zinc-600">
                Taking a while? Make sure the other side is still open.
              </p>
            )}
          </div>
        </>
      )}

      {phase === "done" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400">
              <IconCheck className="size-6" />
            </div>
            <p className="max-w-[22ch] text-balance text-center text-sm leading-relaxed text-zinc-300">
              {doneText}
            </p>
          </div>
          <Button full onClick={onDone}>
            Done
          </Button>
        </>
      )}

      {phase === "stopped" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-red-400/10 text-red-400">
              <IconAlert className="size-6" />
            </div>
            <h2 className="text-lg font-medium tracking-tight text-zinc-100">
              The numbers don't match
            </h2>
            <p className="max-w-[26ch] text-balance text-center text-sm leading-relaxed text-zinc-400">
              This connection isn't safe, so nothing was trusted. Try again on a network you trust.
            </p>
          </div>
          <Button full variant="subtle" onClick={onClose}>
            Close
          </Button>
        </>
      )}
    </Screen>
  );
}
