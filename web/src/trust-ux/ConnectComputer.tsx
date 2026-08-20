"use client";

import { Button, Eyebrow, Screen } from "./bits";

/**
 * First step of connecting a computer. The computer's terminal prints the same
 * six digits this screen will show next — the number check then runs unchanged.
 */
export function ConnectComputer({ command, onCancel }: { command: string; onCancel?: () => void }) {
  return (
    <Screen>
      <Eyebrow>Connect a computer</Eyebrow>
      <div className="flex flex-1 flex-col justify-center gap-5">
        <h2 className="text-lg font-medium tracking-tight text-zinc-100">
          Run this on the computer
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
