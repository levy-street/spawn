"use client";

import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export type NumberCheckPhase = "connecting" | "compare" | "waiting" | "done" | "stopped";

export interface NumberCheckProps {
  phase: NumberCheckPhase;
  /**
   * Which half of the check this screen is (entry-style, never
   * tap-to-approve — docs/TRUST_UX.md): "show" displays the number and waits;
   * "enter" types the number the other screen is showing.
   */
  mode: "show" | "enter";
  /** "923 579" — displayed in `show` mode (and grayed while `waiting`). */
  number?: string;
  /**
   * Legacy hosts (older software) have no number; the check falls back to
   * comparing this full fingerprint — never a weaker code. Compare-style.
   */
  fingerprint?: string;
  /** Where the other half is: "on the new device" / "in the host's terminal". */
  otherScreen: string;
  /** One line shown on success: "mac-studio is possessed. …" */
  doneText: string;
  /** `enter` mode: wrong-entry feedback, e.g. "That's not it — 2 tries left." */
  entryError?: string;
  /** `waiting`: show a quiet nudge once the caller considers it slow. */
  slowHint?: boolean;
  /** Optional line under the stopped headline (defaults to the safe-abort copy). */
  stoppedText?: string;
  /** `enter` mode: called with the six digits once all are typed. */
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
  otherScreen,
  doneText,
  entryError,
  slowHint = false,
  stoppedText,
  onSubmit,
  onMatch,
  onNoMatch,
  onDone,
  onClose,
}: NumberCheckProps) {
  const [entered, setEntered] = useState("");

  const submitIfComplete = (raw: string) => {
    const digits = raw.replace(/\D/gu, "").slice(0, 6);
    setEntered(digits);
    if (digits.length === 6) {
      onSubmit?.(digits);
      setEntered("");
    }
  };

  return (
    <div className="flex min-h-[320px] flex-col" data-testid="number-check" data-phase={phase}>
      {phase === "connecting" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Securing the connection…</p>
        </div>
      )}

      {phase === "compare" && fingerprint !== undefined && (
        <>
          <div className="flex flex-1 flex-col items-center justify-center">
            <h2 className="text-lg font-medium tracking-tight text-foreground">
              Check the fingerprint
            </h2>
            <p
              className="mt-6 break-all rounded-lg bg-muted px-4 py-3 text-center font-mono text-base tracking-wide text-foreground"
              data-testid="host-key-fingerprint"
            >
              {fingerprint}
            </p>
            <p className="mt-6 max-w-[30ch] text-balance text-center text-sm leading-relaxed text-muted-foreground">
              This host runs older software, so compare its full fingerprint — shown {otherScreen}.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button className="w-full" data-testid="fingerprint-match" onClick={onMatch}>
              They match
            </Button>
            <Button className="w-full" variant="ghost" onClick={onNoMatch}>
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
          <div className="flex h-[76px] flex-col items-center justify-center gap-2">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Waiting for the other side…
            </div>
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
              autoComplete="one-time-code"
              placeholder="000 000"
              aria-label="The six-digit number shown on the other screen"
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
          <Button className="w-full" variant="ghost" onClick={onNoMatch}>
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
          <div className="flex h-[76px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-3">
              <Loader2 className="size-4 animate-spin" />
              Waiting for the other side…
            </div>
            {slowHint && (
              <p className="text-xs text-muted-foreground/70">
                Taking a while? Make sure the other side is still open.
              </p>
            )}
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
          <Button className="w-full" onClick={onDone}>
            Done
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
          <Button className="w-full" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      )}
    </div>
  );
}
