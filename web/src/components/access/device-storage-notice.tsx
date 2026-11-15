"use client";

import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useCurrentDeviceApproval } from "@/components/access/use-current-device-approval";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { toast } from "@/components/ui/toast";
import { useAuth } from "@/lib/auth";
import {
  DEVICE_STORAGE_NOTICE,
  deviceStorageNoticeDismissedKey,
  deviceStorageNoticeWanted,
} from "@/lib/device-storage-notice";
import { useDeviceStoragePersistence } from "@/lib/persistent-storage";
import { isDesktopShell } from "@/lib/platform";
import { usePasskeyTrust } from "@/lib/trust-passkeys";

function readDismissed(accountId: string): boolean {
  try {
    return window.localStorage.getItem(deviceStorageNoticeDismissedKey(accountId)) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(accountId: string): void {
  try {
    window.localStorage.setItem(deviceStorageNoticeDismissedKey(accountId), "1");
  } catch {
    // Storage denied: `answered` below still holds for this page load.
  }
}

/**
 * Kept for the whole page load, not per mount. AppShell is rendered by each
 * page, so this component remounts on every navigation; the notice it raised
 * stays in the toast store and the next mount keeps it, rather than dropping
 * it and raising it again (which slid it out and back in on every page).
 */
let raised: { accountId: string; id: number } | null = null;
/** Accounts whose notice was answered on this page load. */
const answered = new Set<string>();

/**
 * Not now and the X are remembered in this browser; Add passkey stands the
 * notice down until the next load (it comes back while there is still no
 * passkey). Module-level, so it works whichever mount raised the notice.
 */
function answerNotice(accountId: string, remember: boolean): void {
  if (remember) rememberDismissed(accountId);
  answered.add(accountId);
  if (raised !== null) toast.dismiss(raised.id);
  raised = null;
}

/**
 * The quiet notice that this browser can lose its approval
 * (`lib/device-storage-notice.ts` says when, and why only in a browser).
 *
 * Raised at most once per page load, in the ordinary notice place. It shows
 * only to a browser that is approved now, by the session gate's own test, and
 * stands down for good the moment the account has a passkey. It reads the
 * queries the app already keeps warm, so it adds no requests of its own.
 */
export function DeviceStorageNotice() {
  const { user } = useAuth();
  const accountId = user?.id ?? null;
  const persistence = useDeviceStoragePersistence();
  const passkey = usePasskeyTrust();
  const approval = useCurrentDeviceApproval({ enabled: accountId !== null });
  // Both read in effects, never during render. Until they are read nothing
  // changes: no flash of a new notice, and no drop of one already up.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [desktopShell, setDesktopShell] = useState<boolean | null>(null);
  useEffect(() => {
    setDesktopShell(isDesktopShell(window.navigator.userAgent));
  }, []);
  useEffect(() => {
    if (accountId !== null) setDismissed(readDismissed(accountId));
  }, [accountId]);

  const bundle = passkey.bundle.data;
  const wanted =
    accountId !== null && dismissed !== null && desktopShell !== null
      ? deviceStorageNoticeWanted({
          persistence,
          hasPasskey: bundle === undefined ? null : bundle !== null,
          approved: approval.ready ? approval.trusted : null,
          dismissed: dismissed || answered.has(accountId),
          desktopShell,
        })
      : null;

  useEffect(() => {
    if (wanted === null || accountId === null) return;
    if (raised !== null && (!wanted || raised.accountId !== accountId)) {
      toast.dismiss(raised.id);
      raised = null;
    }
    if (!wanted || raised !== null) return;
    raised = {
      accountId,
      id: toast(DEVICE_STORAGE_NOTICE.title, {
        detail: DEVICE_STORAGE_NOTICE.body,
        icon: <KeyRound className="size-4 text-muted-foreground" aria-hidden />,
        persistent: true,
        onDismiss: () => answerNotice(accountId, true),
        actions: [
          { label: DEVICE_STORAGE_NOTICE.notNow, onClick: () => answerNotice(accountId, true) },
          {
            label: DEVICE_STORAGE_NOTICE.addPasskey,
            variant: "primary",
            onClick: () => {
              answerNotice(accountId, false);
              openSettings("account");
            },
          },
        ],
      }),
    };
  }, [wanted, accountId]);

  // The notice lives in the toast host; this only decides whether it exists.
  return null;
}
