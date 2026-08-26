"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PaceBar } from "@/components/ui/pace-bar";

export type NumberCheckPhase =
  | "connecting"
  | "compare"
  | "waiting"
  | "done"
  | "half-done"
  | "stopped";

export interface NumberCheckProps {
  phase: NumberCheckPhase;
  /**
   * Which half of the check this screen is (entry-style, never
   * tap-to-approve — docs/TRUST_UX.md): "show" displays the number and waits;
   * "enter" types the number the other screen is showing.
   */
  mode: "show" | "enter";
  /** e.g. "9728" (device, 4 digits) or "923 579" (host, 6) — shown in `show` mode. */
  number?: string;
  /**
   * Legacy hosts (older software) have no number; the check falls back to
   * comparing this full fingerprint — never a weaker code. Compare-style.
   */
  fingerprint?: string;
  /** Optional context for a current host using the no-fragment fallback. */
  fingerprintHelp?: string;
  /** Where the other half is: "on the new device" / "in the host's terminal". */
  otherScreen: string;
  /** One line shown on success: "mac-studio is possessed. …" */
  doneText: string;
  /** `enter` mode: wrong-entry feedback, e.g. "That's not it — 2 tries left." */
  entryError?: string;
  /** How many digits to expect/type: 6 for host possession, 4 for device↔device. */
  digits?: number;
  /** `waiting`: show a quiet nudge once the caller considers it slow. */
  slowHint?: boolean;
  /** `waiting`: reveal Cancel once the caller's operation can be abandoned. */
  waitingEscape?: boolean;
  /** Optional line under the stopped headline (defaults to the safe-abort copy). */
  stoppedText?: string;
  /** `half-done`: the honest in-between — this side finished, the other never
   * did. States what worked and the one step that finishes the link. */
  halfDoneText?: string;
  /**
   * Drop the reserved height and the standalone heading.
   *
   * Full size, this is a screen: it holds its 320px so the ceremony does not
   * jump between phases, and titles itself. Embedded in a card that has already
   * introduced the step, both work against it — the reserved height pushes the
   * action below the fold, and the title repeats the one above it.
   */
  compact?: boolean;
  /** `enter` mode: called with the digits once `digits` of them are typed. */
  onSubmit?: (digits: string) => void;
  /** Fingerprint fallback only. */
  onMatch?: () => void;
  /** "I don't see a number" / "They don't match" — always terminal. */
  onNoMatch?: () => void;
  onDone?: () => void;
  onClose?: () => void;
}

/**
 * The one human check in the whole system (the committed SAS, mesh Appendix A),
 * in the product's design system. One side shows the number, the other types
 * it — used unchanged for approving a device and possessing a host. Mismatch
 * is terminal — there is no "approve anyway".
 *
 * Presentation only: every trust decision (SAS computation, commitment
 * verification, signing) stays with the caller.
 */
export function NumberCheck({
  phase,
  mode,
  number,
  fingerprint,
  fingerprintHelp,
  otherScreen,
  doneText,
  entryError,
  digits: expected = 6,
  slowHint = false,
  waitingEscape = false,
  stoppedText,
  halfDoneText,
  compact = false,
  onSubmit,
  onMatch,
  onNoMatch,
  onDone,
  onClose,
}: NumberCheckProps) {
  const [entered, setEntered] = useState("");

  const submitIfComplete = (raw: string) => {
    const digits = raw.replace(/\D/gu, "").slice(0, expected);
    setEntered(digits);
    if (digits.length === expected) {
      onSubmit?.(digits);
      setEntered("");
    }
  };

  return (
    <div
      className={compact ? "flex flex-col" : "flex min-h-[320px] flex-col"}
      data-testid="number-check"
      data-phase={phase}
    >
      {phase === "connecting" && (
        <div className="flex flex-1 flex-col items-center justify-center">
          <PaceBar className="w-full max-w-xs" label="Securing the connection…" />
        </div>
      )}

      {phase === "compare" && fingerprint !== undefined && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center">
            {compact ? null : (
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Check the fingerprint
              </h2>
            )}
            <p
              className={`${compact ? "mt-1" : "mt-6"} break-all rounded-lg bg-muted px-4 py-3 text-center font-mono text-base tracking-wide text-foreground`}
              data-testid="host-key-fingerprint"
            >
              {fingerprint}
            </p>
            <p
              className={`${compact ? "mt-3" : "mt-6"} max-w-[34ch] text-balance text-center text-sm leading-relaxed text-muted-foreground`}
            >
              {fingerprintHelp ??
                `This host runs older software, so compare its full fingerprint — shown ${otherScreen}.`}
            </p>
          </div>
          {/* One action, then the way out of it. Equal-weight full-width
              buttons made "they don't match" read as a second choice rather
              than the alarm it is, and put three near-identical bars in a row
              with nothing to tell them apart. */}
          <div className={compact ? "mt-6 flex flex-col gap-3" : "flex flex-col gap-3"}>
            <Button className="w-full" data-testid="fingerprint-match" onClick={onMatch}>
              They match
            </Button>
            {/* Same width as the action above it: these are the two answers to
                one question, and the alarm is not a footnote. Weight, not size,
                is what says which one is the way forward. */}
            <Button
              className="w-full text-muted-foreground hover:text-destructive"
              variant="ghost"
              onClick={onNoMatch}
            >
              They don't match
            </Button>
          </div>
        </>
      )}

      {phase === "compare" && fingerprint === undefined && mode === "show" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center">
            <h2 className="text-lg font-medium tracking-tight text-foreground">Your number</h2>
            <p
              className="mt-6 font-mono text-5xl font-semibold tabular-nums tracking-[0.14em] text-foreground"
              data-testid="ceremony-sas"
            >
              {number}
            </p>
            <p className="mt-6 max-w-[24ch] text-balance text-center text-sm leading-relaxed text-muted-foreground">
              Enter this number {otherScreen}.
            </p>
          </div>
          {/* No pace bar: nothing is loading here. This side is waiting on a
              person to type four digits on another screen, and a progress bar
              over that reads as work that might finish on its own. */}
          <div className="flex h-[76px] w-full flex-col items-center justify-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === "compare" && fingerprint === undefined && mode === "enter" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center">
            <h2 className="text-lg font-medium tracking-tight text-foreground">Enter the number</h2>
            <input
              value={entered}
              onChange={(event) => submitIfComplete(event.target.value)}
              inputMode="numeric"
              maxLength={expected}
              autoComplete="one-time-code"
              placeholder={"0".repeat(expected)}
              aria-label={`The ${expected}-digit number shown on the other screen`}
              data-testid="number-entry"
              // biome-ignore lint/a11y/noAutofocus: the entry field is this screen's entire purpose
              autoFocus
              className="mt-6 w-[220px] rounded-xl border border-border bg-background py-3 text-center font-mono text-4xl font-semibold tabular-nums tracking-[0.14em] text-foreground placeholder:text-muted-foreground/30 focus:border-ring focus:outline-none"
            />
            {entryError !== undefined ? (
              <p className="mt-4 text-sm text-destructive" data-testid="entry-error" role="alert">
                {entryError}
              </p>
            ) : (
              <p className="mt-4 max-w-[24ch] text-balance text-center text-sm leading-relaxed text-muted-foreground">
                Type the number shown {otherScreen}.
              </p>
            )}
          </div>
          <Button className="mt-6 w-full" variant="ghost" onClick={onNoMatch}>
            I don't see a number
          </Button>
        </>
      )}

      {phase === "waiting" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center">
            <h2 className="text-lg font-medium tracking-tight text-foreground">Almost there</h2>
            {number !== undefined && (
              <p className="mt-6 font-mono text-5xl font-semibold tabular-nums tracking-[0.14em] text-muted-foreground/50">
                {number}
              </p>
            )}
            <p className="mt-6 max-w-[24ch] text-balance text-center text-sm leading-relaxed text-muted-foreground">
              Confirmed here. Finishing up {otherScreen}.
            </p>
          </div>
          <div className="flex h-[76px] w-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <PaceBar className="w-full max-w-xs" label="Waiting for the other side…" />
            {slowHint && (
              <p className="text-xs text-muted-foreground/70">
                Taking a while? Make sure the other side is still open.
              </p>
            )}
            {waitingEscape && onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                Cancel
              </button>
            ) : null}
          </div>
        </>
      )}

      {phase === "done" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
              <Check className="size-6" />
            </div>
            <p
              className="max-w-[26ch] text-balance text-center text-sm leading-relaxed text-foreground"
              data-testid="ceremony-done"
              role="status"
            >
              {doneText}
            </p>
          </div>
          <Button className="mt-6 w-full" onClick={onDone}>
            Done
          </Button>
        </>
      )}

      {phase === "half-done" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
              <AlertTriangle className="size-6" />
            </div>
            <h2 className="text-lg font-medium tracking-tight text-foreground">Not finished</h2>
            <p
              className="max-w-[28ch] text-balance text-center text-sm leading-relaxed text-muted-foreground"
              data-testid="ceremony-half-done"
              role="status"
            >
              {halfDoneText ??
                "Approved on this side, but the other device didn't finish. Approve it again from the device list to finish the link."}
            </p>
          </div>
          <Button className="mt-6 w-full" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      )}

      {phase === "stopped" && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="size-6" />
            </div>
            <h2 className="text-lg font-medium tracking-tight text-foreground">
              The numbers don't match
            </h2>
            <p className="max-w-[28ch] text-balance text-center text-sm leading-relaxed text-muted-foreground">
              {stoppedText ??
                "This connection isn't safe, so nothing was trusted. Try again on a network you trust."}
            </p>
          </div>
          {/* The copy above ends in a refusal; crowding the only way out
              against it makes the button read as part of the sentence. */}
          <Button className="mt-6 w-full" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      )}
    </div>
  );
}
