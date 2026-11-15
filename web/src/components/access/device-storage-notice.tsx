"use client";

import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
    // Storage denied: the in-memory flag still holds for this page.
  }
}

/**
 * The quiet notice that this browser can lose its approval
 * (`lib/device-storage-notice.ts` says when, and why only in a browser).
 *
 * Raised at most once per page, in the ordinary notice place. "Not now" and
 * the X are remembered in this browser; "Add passkey" opens Account, where
 * passkeys are added, and the notice stands down for good the moment the
 * account has one. It reads the same passkey queries the session gate
 * already runs on every page, so it adds no requests of its own.
 */
export function DeviceStorageNotice() {
  const { user } = useAuth();
  const accountId = user?.id ?? null;
  const persistence = useDeviceStoragePersistence();
  const passkey = usePasskeyTrust();
  // Until this browser's record is read, assume dismissed: never flash it.
  const [dismissed, setDismissed] = useState(true);
  const [desktopShell, setDesktopShell] = useState(true);
  useEffect(() => {
    setDesktopShell(isDesktopShell(window.navigator.userAgent));
  }, []);
  useEffect(() => {
    if (accountId !== null) setDismissed(readDismissed(accountId));
  }, [accountId]);

  const bundle = passkey.bundle.data;
  const wanted =
    accountId !== null &&
    deviceStorageNoticeWanted({
      persistence,
      hasPasskey: bundle === undefined ? null : bundle !== null,
      localHostCount: passkey.localPins.data?.length ?? null,
      dismissed,
      desktopShell,
    });

  const noticeId = useRef<number | null>(null);
  const raisedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || accountId === null) {
      if (noticeId.current !== null) toast.dismiss(noticeId.current);
      noticeId.current = null;
      return;
    }
    if (raisedFor.current === accountId) return;
    raisedFor.current = accountId;
    const remember = () => {
      rememberDismissed(accountId);
      setDismissed(true);
    };
    noticeId.current = toast(DEVICE_STORAGE_NOTICE.title, {
      detail: DEVICE_STORAGE_NOTICE.body,
      icon: <KeyRound className="size-4 text-muted-foreground" aria-hidden />,
      persistent: true,
      onDismiss: remember,
      actions: [
        { label: DEVICE_STORAGE_NOTICE.notNow, onClick: remember },
        {
          label: DEVICE_STORAGE_NOTICE.addPasskey,
          variant: "primary",
          onClick: () => {
            if (noticeId.current !== null) toast.dismiss(noticeId.current);
            noticeId.current = null;
            openSettings("account");
          },
        },
      ],
    });
  }, [wanted, accountId]);

  useEffect(
    () => () => {
      if (noticeId.current !== null) toast.dismiss(noticeId.current);
    },
    [],
  );

  // The notice lives in the toast host; this only decides whether it exists.
  return null;
}
