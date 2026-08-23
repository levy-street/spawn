"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useDeviceTrustMap, useEndorseDevice } from "@/components/trust/device-endorsement";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  // Only a browser some host already trusts can sign an endorsement. Prompting
  // one that could only fail is worse than staying quiet — it is also the case
  // for the browser that is itself waiting to be let in.
  const canApprove =
    thisBrowser !== undefined && trustMap.trustedHostIdsFor(thisBrowser.id).length > 0;

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

  if (accountId === null || request === undefined || target === undefined || !canApprove) {
    return null;
  }

  const busy = endorse.isPending || deny.isPending;
  const label = target.label ?? "A device";

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : dismiss(request.id))}>
      <DialogContent size="sm" hideClose data-testid="device-approval-prompt">
        <DialogHeader>
          <DialogTitle>{label} wants to connect</DialogTitle>
          <DialogDescription>
            It signed in to your account and cannot open anything until a device you already trust
            vouches for it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-sm">Check that the asking device shows exactly this fingerprint:</p>
          <p className="break-all rounded bg-muted px-2 py-1.5 font-mono text-sm font-semibold">
            {request.fingerprint}
          </p>
          <p className="text-xs text-muted-foreground">
            The name is a label anyone can set — only a matching fingerprint proves you are trusting
            the device you think you are. If it differs, deny.
          </p>
          {failure !== null && (
            <p className="text-sm text-destructive" role="alert">
              {failure}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => deny.mutate(request.id)}
          >
            Deny
          </Button>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
