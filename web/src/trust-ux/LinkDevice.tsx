"use client";

import { Button, Eyebrow, IconLaptop, IconPhone, Screen, Spinner } from "./bits";
import type { DeviceKind } from "./types";

/**
 * The new device, freshly signed in, before any ceremony.
 * With a passkey this screen is never seen — recovery admits the device silently.
 */
export function LinkNewDevice({ onCancel }: { onCancel?: () => void }) {
  return (
    <Screen>
      <Eyebrow>Link this device</Eyebrow>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <Spinner />
        <h2 className="text-lg font-medium tracking-tight text-zinc-100">
          Confirm from another device
        </h2>
        <p className="max-w-[26ch] text-balance text-sm leading-relaxed text-zinc-400">
          Open spawn on a device you already use — or sign in here with your recovery passkey.
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
 * nothing is trusted until the numbers match there.
 */
export function LinkRequest({
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
        <h2 className="text-lg font-medium tracking-tight text-zinc-100">Link {deviceName}?</h2>
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
