"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { requestApproval } from "@/components/access/ceremony-store";
import { Trident } from "@/components/icons/BrandMark";
import {
  useAccountEndorsementEdges,
  useDeviceTrustMap,
} from "@/components/trust/device-endorsement";
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
import { hostsTrustingDevice } from "@/lib/trust-roster";

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
 * signing an endorsement, and only a browser some host already trusts, either
 * directly or through an account chain, can sign one that any host will
 * honour. Prompting a browser that would only fail is worse than staying
 * quiet. The hosts the approval reaches are named in the dialog, so "approve"
 * never promises more than the hosts anchored on this browser.
 *
 * Approving is the number check (mesh §4 add-device, Appendix A), the same
 * ceremony a browser gets: "Enter its number" starts the committed SAS
 * toward the asking device, which shows a four-digit number on its screen for
 * the human to type here. There is no look-and-click approve; a number the
 * server cannot grind is the whole point. While the ceremony is live this
 * dialog stands aside for it, and the knock closes when the endorsement lands.
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
  const edges = useAccountEndorsementEdges(accountId !== null);
  const thisBrowser = (devices.data ?? []).find(
    (device) => device.public_key === identity.data?.publicKeyWire,
  );
  // Only a browser some host already trusts can vouch at all, and the approval
  // it signs reaches exactly the hosts that trust it (mesh §3).
  const coveredHosts =
    thisBrowser === undefined
      ? []
      : hostsTrustingDevice(
          thisBrowser.id,
          trustMap.keyedHosts,
          trustMap.pinsByHost,
          devices.data ?? [],
          edges.data ?? [],
        );
  const canHelp = coveredHosts.length > 0;

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

  // The ceremony host drives the relay; this dialog only asks it to start and
  // then gets out of the way while a ceremony with the asking device is live.
  const pairings = useQuery({
    queryKey: ["device-pairings", thisBrowser?.id ?? null],
    queryFn: () => trust.listPairings(thisBrowser?.id ?? ""),
    enabled: accountId !== null && thisBrowser !== undefined && request !== undefined,
    refetchInterval: 1500,
  });
  const ceremonyLive = (pairings.data ?? []).some(
    (row) => row.joiner_device_id === request?.browser_device_id,
  );

  const deny = useMutation({
    mutationFn: (requestId: string) => trust.denyDeviceApproval(requestId),
    onSuccess: (_result, requestId) => {
      dismiss(requestId);
      void queryClient.invalidateQueries({ queryKey: ["trust", "device-approvals"] });
    },
    onError: (error) => setFailure(error instanceof Error ? error.message : String(error)),
  });

  if (
    accountId === null ||
    request === undefined ||
    target === undefined ||
    !canHelp ||
    ceremonyLive
  ) {
    return null;
  }

  const busy = deny.isPending;
  const label = target.label ?? "A new device";

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : dismiss(request.id))}>
      <DialogContent size="md" hideClose data-testid="device-approval-prompt">
        <DialogHeader className="items-center px-6 pt-7 text-center">
          <Trident className="mb-3 size-12" />
          <DialogTitle className="text-lg">Approve {label}?</DialogTitle>
          <DialogDescription className="max-w-[44ch]">
            It signed in to your account. It cannot open anything on your hosts until you approve it
            here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 py-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            To approve it, type the number it shows on its screen. The number only appears there, so
            nobody can approve a device they are not holding.
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            This approval covers{" "}
            <span className="font-medium text-foreground">
              {formatHostList(coveredHosts.map((h) => h.name))}
            </span>
            . Any other host will ask again from a screen it already trusts.
          </p>
          {failure !== null && (
            <p className="text-sm text-destructive" role="alert">
              {failure}
            </p>
          )}
        </div>

        <DialogFooter className="px-6 pb-6 pt-3">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => deny.mutate(request.id)}
          >
            Deny
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setFailure(null);
              requestApproval(target.id);
            }}
          >
            Enter its number
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "dream", "dream and minivac", "dream, minivac and 3 more". */
function formatHostList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  const shown = names.slice(0, 2).join(", ");
  const rest = names.length - 2;
  return `${shown} and ${rest} more`;
}
