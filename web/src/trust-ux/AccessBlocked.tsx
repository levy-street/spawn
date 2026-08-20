"use client";

import { Button, IconBlocked, Screen } from "./bits";

export type AccessBlockedVariant = "removed" | "not-linked";

/**
 * What a refused device sees. Removal is permanent (R10): the only way back is
 * to start over as a new device. The "removed" screen names who removed it —
 * R4's audit surface at the sharp end.
 */
export function AccessBlocked({
  variant,
  detail,
  onLink,
  onSignOut,
}: {
  variant: AccessBlockedVariant;
  /** e.g. "Removed Aug 12 by MacBook Pro." — the actor, matching "Linked by". */
  detail?: string;
  onLink?: () => void;
  onSignOut?: () => void;
}) {
  return (
    <Screen>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        {variant === "removed" ? (
          <>
            <span className="flex size-12 items-center justify-center rounded-full bg-red-400/10 text-red-400">
              <IconBlocked className="size-6" />
            </span>
            <h2 className="text-lg font-medium tracking-tight text-zinc-100">
              This device was removed
            </h2>
            <p className="max-w-[26ch] text-balance text-sm leading-relaxed text-zinc-400">
              {detail} It can start over as a new device.
            </p>
          </>
        ) : (
          <>
            <span className="flex size-12 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400">
              <IconBlocked className="size-6" />
            </span>
            <h2 className="text-lg font-medium tracking-tight text-zinc-100">One step left</h2>
            <p className="max-w-[26ch] text-balance text-sm leading-relaxed text-zinc-400">
              This device isn't linked yet, so your machines stay out of reach.
            </p>
          </>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Button full onClick={onLink}>
          {variant === "removed" ? "Link as a new device" : "Link this device"}
        </Button>
        <Button full variant="ghost" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </Screen>
  );
}
