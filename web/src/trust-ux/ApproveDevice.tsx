"use client";

import { Button, Eyebrow, IconLaptop, IconPhone, Screen, Spinner } from "./bits";
import type { DeviceKind } from "./types";

/**
 * The new device, freshly signed in. It is already visible in every roster —
 * approval is what it's waiting for. With a passkey this screen is never seen:
 * signing in with it is the approval.
 */
export function WaitingForApproval({ onCancel }: { onCancel?: () => void }) {
  return (
    <Screen>
      <Eyebrow>Approve this device</Eyebrow>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <Spinner />
        <h2 className="text-lg font-medium tracking-tight text-zinc-100">Waiting for approval</h2>
        <p className="max-w-[26ch] text-balance text-sm leading-relaxed text-zinc-400">
          Approve from a device you already use — or sign in here with your passkey.
        </p>
      </div>
      <Button full variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </Screen>
  );
}

/**
 * The prompt an existing device receives. Approving opens the number check;
 * nothing is trusted until the number is entered there.
 */
export function ApproveRequest({
  deviceName,
  deviceKind,
  account,
  onEnterNumber,
  onIgnore,
}: {
  deviceName: string;
  deviceKind: DeviceKind;
  account: string;
  onEnterNumber?: () => void;
  onIgnore?: () => void;
}) {
  return (
    <Screen>
      <Eyebrow>New device</Eyebrow>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-300">
          {deviceKind === "phone" ? (
            <IconPhone className="size-6" />
          ) : (
            <IconLaptop className="size-6" />
          )}
        </span>
        <h2 className="text-lg font-medium tracking-tight text-zinc-100">Approve {deviceName}?</h2>
        <p className="max-w-[26ch] text-balance text-sm leading-relaxed text-zinc-400">
          It just signed in as {account}. If that wasn't you, ignore this.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Button full onClick={onEnterNumber}>
          Enter its number
        </Button>
        <Button full variant="ghost" onClick={onIgnore}>
          Ignore
        </Button>
      </div>
    </Screen>
  );
}

/**
 * The same request as it arrives on a desktop: a corner toast over whatever
 * the user is doing. Approving opens the number check; Ignore dismisses —
 * nothing is trusted from this card alone.
 */
export function ApproveRequestToast({
  deviceName,
  deviceKind,
  onEnterNumber,
  onIgnore,
}: {
  deviceName: string;
  deviceKind: DeviceKind;
  onEnterNumber?: () => void;
  onIgnore?: () => void;
}) {
  return (
    <div className="w-[320px] rounded-2xl border border-zinc-700/80 bg-zinc-900 p-4 shadow-2xl shadow-black/50">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-300">
          {deviceKind === "phone" ? <IconPhone /> : <IconLaptop />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-100">Approve {deviceName}?</p>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
            It just signed in as you. If that wasn't you, ignore this.
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button onClick={onEnterNumber}>Enter its number</Button>
        <Button variant="ghost" onClick={onIgnore}>
          Ignore
        </Button>
      </div>
    </div>
  );
}
