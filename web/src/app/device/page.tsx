"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { ConnectHostSection } from "@/components/hosts/connect-host";
import { AppShell } from "@/components/nav/AppShell";
import { hosts } from "@/lib/api";
import { restoreDeviceApproval } from "@/lib/device-approval-stash";

/**
 * Possessing a host (docs/TRUST_UX.md §4): `spawnd possess` opens/prints a
 * link that carries the host's identity key in its URL fragment. This route
 * is the one place that reads it — `autoLoadFromUrl` turns on the invisible
 * out-of-band check, so an exact match reduces the human's part to a single
 * Approve and a mismatch is refused outright.
 */
export default function DevicePage() {
  return (
    <AuthGate>
      <DeviceRoute />
    </AuthGate>
  );
}

/**
 * Who this approval belongs to, before any of it is drawn.
 *
 * An account with no host has not finished onboarding: connecting one is the
 * gate it is sitting on. Handing that person the approval inside the app
 * chrome dropped them into a product they had not set up yet, finished the
 * ceremony there, and then offered them a button back out to the flow they
 * were already in — into the app and straight back out. Onboarding's own host
 * step consumes exactly the same ceremony (the URL's `?ref=`/`#k=`, or the
 * sessionStorage stash a login round-trip left behind), so the link is handed
 * to it and finishes in the flow the account is actually in. `/signup` already
 * does this for the visitor who has no account at all.
 */
function DeviceRoute() {
  const router = useRouter();
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, retry: 1 });
  // An error is not "no hosts": failing to reach the server must not divert a
  // ceremony this page can still run.
  const firstMachine = hostsQ.data !== undefined && hostsQ.data.length === 0;
  /**
   * Whether the wait for that answer has run out.
   *
   * The answer usually lands in a blink and the reader sees none of this. But
   * a server this page cannot reach never answers at all — and a browser held
   * on a spinner cannot even be told that, while the approval it came to
   * finish is one render away. So the wait is bounded: past it, the ceremony
   * is shown here, which is where it worked before any of this existed.
   */
  const [waitedLongEnough, setWaitedLongEnough] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setWaitedLongEnough(true), 1_200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!firstMachine) return;
    // Search and fragment carried verbatim: the `#k=` is the out-of-band half
    // of the identity check and there is no other copy of it once it is off
    // this URL. Anything still in the stash travels on its own — onboarding
    // reads it too — so a login round-trip that lost the fragment is fine.
    router.replace(`/onboarding${window.location.search}${window.location.hash}`);
  }, [firstMachine, router]);

  if (firstMachine) {
    return (
      <div className="flex min-h-vv items-center justify-center text-sm text-muted-foreground">
        Taking you to setup…
      </div>
    );
  }
  if (hostsQ.data === undefined && !hostsQ.isError && !waitedLongEnough) {
    return (
      <div className="flex min-h-vv items-center justify-center text-sm text-muted-foreground">
        Opening this approval…
      </div>
    );
  }

  return (
    <AppShell>
      <DeviceApprovalBody />
    </AppShell>
  );
}

function DeviceApprovalBody() {
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const restoredPath = restoreDeviceApproval(window.sessionStorage, window.location.href);
    if (restoredPath) window.history.replaceState(window.history.state, "", restoredPath);
    setRestored(true);
  }, []);

  return (
    <main className="mx-auto w-full max-w-xl space-y-4 p-4 @md/shell:p-6">
      {restored ? (
        <ConnectHostSection autoLoadFromUrl />
      ) : (
        <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
          Restoring approval…
        </div>
      )}
    </main>
  );
}
