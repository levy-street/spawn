"use client";

import { Button, Eyebrow, Screen } from "./bits";

/**
 * First step of possessing a machine — the product's own verb, the same one the
 * terminal prints. Its terminal shows six digits; the number check runs unchanged.
 */
export function PossessMachine({ command, onCancel }: { command: string; onCancel?: () => void }) {
  return (
    <Screen>
      <Eyebrow>Possess a machine</Eyebrow>
      <div className="flex flex-1 flex-col justify-center gap-5">
        <h2 className="text-lg font-medium tracking-tight text-zinc-100">
          Run this on the machine
        </h2>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3 font-mono text-sm text-zinc-200">
          <span className="select-none text-zinc-600">$ </span>
          {command}
        </div>
        <p className="text-sm leading-relaxed text-zinc-400">
          Its terminal will show a six-digit number. You'll type it here.
        </p>
      </div>
      <Button full variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </Screen>
  );
}
