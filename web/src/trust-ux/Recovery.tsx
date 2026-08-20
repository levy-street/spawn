"use client";

import { Button, DialogCard, IconKey } from "./bits";

/**
 * The R8 decision point, stated once and plainly. Behind "Create passkey" the
 * machine does everything (root mint, sealing, healing) with zero further UI.
 */
export function TurnOnRecoveryDialog({
  onCreate,
  onNotNow,
}: {
  onCreate?: () => void;
  onNotNow?: () => void;
}) {
  return (
    <DialogCard>
      <span className="flex size-10 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-400">
        <IconKey className="size-5" />
      </span>
      <h2 className="mt-3 text-base font-medium tracking-tight text-zinc-100">Turn on recovery</h2>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        You'll create a passkey. Lose every device and it still brings everything back — and new
        devices that sign in with it are trusted automatically.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        <Button full onClick={onCreate}>
          Create passkey
        </Button>
        <Button full variant="ghost" onClick={onNotNow}>
          Not now
        </Button>
      </div>
    </DialogCard>
  );
}

/**
 * Root rotation, described honestly: the old recovery's power ends (R10), the
 * next passkey use rebuilds it (§4.1). It does NOT lock out a stolen passkey —
 * the passkey still opens the resealed bundle — so the copy never claims that;
 * passkey compromise is full account compromise (§7) and the real response is
 * removing affected devices and replacing the passkey where it's stored.
 */
export function ResetRecoveryDialog({
  onReset,
  onCancel,
}: {
  onReset?: () => void;
  onCancel?: () => void;
}) {
  return (
    <DialogCard>
      <h2 className="text-base font-medium tracking-tight text-zinc-100">Reset recovery?</h2>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        Recovery stops everywhere, permanently, and is rebuilt the next time you sign in with your
        passkey. Your devices stay linked.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        Worried a passkey leaked? Also delete it from your password manager — resetting alone
        doesn't lock out a stolen passkey.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        <Button full variant="danger" onClick={onReset}>
          Reset recovery
        </Button>
        <Button full variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </DialogCard>
  );
}
