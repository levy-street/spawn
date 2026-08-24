"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, ShieldAlert, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import { useDeviceTrustMap, useEndorseDevice } from "@/components/trust/device-endorsement";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { subscribeToTrustEvents } from "@/lib/alert-socket";
import { type BrowserDevice, browserDevices, type DeviceApprovalRequest, trust } from "@/lib/api";
import { loadBrowserDeviceIdentity } from "@/lib/browser-device-identity";

/**
 * The prompt a trusted browser shows when another device knocks.
 *
 * Mounted in AppShell for the same reason alerts are: this is the one place
 * every signed-in route renders, and the knock has to be seen wherever the
 * operator happens to be looking. It reads the pending list on mount and
 * subscribes to the live frame, so a device that knocks while this tab is
 * already open interrupts it, and one that knocked earlier is still waiting
 * when the tab opens.
 *
 * It renders nothing unless this browser can actually help: approving means
 * signing an endorsement, which only a browser some host already trusts can
 * do. Prompting a browser that would only fail is worse than staying quiet.
 *
 * Chain-capable hosts refuse the per-host endorsement this dialog signs
 * (mesh R9), and the asking device may not speak the account ceremony at all
 * (the phone doesn't yet) — so when no approvable host remains, the dialog
 * offers the path that does work, a `spawnd login` pairing code, instead of
 * an approve button that can only throw.
 */
export function DeviceApprovalPrompt({ accountId }: { accountId: string | null }) {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);

  const pending = useQuery({
    queryKey: ["trust", "device-approvals"],
    queryFn: () => trust.listDeviceApprovals(),
    enabled: accountId !== null,
    // The socket is the fast path; this is the floor under a dropped frame.
    refetchInterval: 60_000,
  });

  const devices = useQuery({
    queryKey: ["trust", "browser-devices"],
    queryFn: () => browserDevices.list(),
    enabled: accountId !== null,
  });

  const identity = useQuery({
    queryKey: ["trust", "local-identity", accountId],
    queryFn: () => (accountId === null ? null : loadBrowserDeviceIdentity(accountId)),
    enabled: accountId !== null,
  });
  const trustMap = useDeviceTrustMap(accountId !== null);
  const thisBrowser = (devices.data ?? []).find(
    (device) => device.public_key === identity.data?.publicKeyWire,
  );
  // Only a browser some host already trusts can vouch at all. Within that,
  // the per-host endorsement this dialog signs works only toward hosts that
  // have not moved to account chains (mesh R9).
  const trustedHostIds =
    thisBrowser === undefined ? [] : trustMap.trustedHostIdsFor(thisBrowser.id);
  const canHelp = trustedHostIds.length > 0;
  const legacyHosts = trustedHostIds
    .map((hostId) => trustMap.hostsById.get(hostId))
    .filter((host) => host !== undefined && host.supports_account_chains !== true);
  const canApprove = legacyHosts.length > 0;

  useEffect(() => {
    if (accountId === null) return;
    return subscribeToTrustEvents(() => {
      void queryClient.invalidateQueries({ queryKey: ["trust", "device-approvals"] });
      void queryClient.invalidateQueries({ queryKey: ["trust", "browser-devices"] });
    });
  }, [accountId, queryClient]);

  const request: DeviceApprovalRequest | undefined = (pending.data ?? []).find(
    (candidate) => !dismissed.has(candidate.id) && candidate.browser_device_id !== thisBrowser?.id,
  );
  const target: BrowserDevice | undefined = (devices.data ?? []).find(
    (device) => device.id === request?.browser_device_id && device.revoked_at === null,
  );

  const dismiss = (requestId: string): void => {
    setFailure(null);
    setDismissed((current) => new Set(current).add(requestId));
  };

  const endorse = useEndorseDevice(accountId ?? "", () => {
    if (request) dismiss(request.id);
    void queryClient.invalidateQueries({ queryKey: ["trust", "device-approvals"] });
  });

  const deny = useMutation({
    mutationFn: (requestId: string) => trust.denyDeviceApproval(requestId),
    onSuccess: (_result, requestId) => {
      dismiss(requestId);
      void queryClient.invalidateQueries({ queryKey: ["trust", "device-approvals"] });
    },
    onError: (error) => setFailure(error instanceof Error ? error.message : String(error)),
  });

  if (accountId === null || request === undefined || target === undefined || !canHelp) {
    return null;
  }

  const busy = endorse.isPending || deny.isPending;
  const label = target.label ?? "A device";
  const isPhone = /iphone|ipad|android|pixel|phone|tablet/iu.test(label);
  const DeviceGlyph = isPhone ? Smartphone : Laptop;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : dismiss(request.id))}>
      <DialogContent size="sm" hideClose data-testid="device-approval-prompt">
        <div className="flex flex-col items-center gap-1 pt-2 text-center">
          <span className="flex size-12 items-center justify-center rounded-full border border-border bg-muted/60">
            <DeviceGlyph aria-hidden className="size-6 text-muted-foreground" />
          </span>
          <DialogTitle className="pt-2 text-base font-semibold">
            {label} is asking to join
          </DialogTitle>
          <DialogDescription className="max-w-[36ch] text-sm text-muted-foreground">
            It signed in as you, and stays locked out of every host until you vouch for it.
          </DialogDescription>
        </div>

        <div className="space-y-2 pt-1">
          <p className="select-all break-all rounded-lg border border-border bg-muted/60 px-3 py-3 text-center font-mono text-base font-semibold tracking-wide">
            {request.fingerprint}
          </p>
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            The asking device shows a fingerprint on its screen. It must match this one, character
            for character — the name above is a label anyone can set; only the fingerprint proves
            which device you are trusting.
          </p>
        </div>

        {!canApprove && (
          <div className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert aria-hidden className="size-4 text-muted-foreground" />
              Your hosts take a pairing code
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              They use account-wide trust, which {label} cannot join remotely yet. On the host, run{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">spawnd login</code>{" "}
              and enter the code it prints on {label} under{" "}
              <span className="text-foreground">Enter a pairing code</span>.
            </p>
          </div>
        )}

        {failure !== null && (
          <p className="text-center text-sm text-destructive" role="alert">
            {failure}
          </p>
        )}

        <div className="flex justify-center gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => deny.mutate(request.id)}
          >
            Deny
          </Button>
          {canApprove ? (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => {
                setFailure(null);
                endorse.mutate(
                  { target, targetFingerprint: request.fingerprint },
                  {
                    onError: (error) =>
                      setFailure(error instanceof Error ? error.message : String(error)),
                  },
                );
              }}
            >
              {endorse.isPending ? "Approving…" : "It matches — approve"}
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={busy} onClick={() => dismiss(request.id)}>
              Got it
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
