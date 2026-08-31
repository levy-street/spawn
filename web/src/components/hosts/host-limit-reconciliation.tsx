"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HostKeepPicker,
  keepCountLabel,
  releaseHosts,
  useHostKeepSelection,
} from "@/components/hosts/host-keep-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useBilling } from "@/hooks/useBilling";
import { hosts } from "@/lib/api";
import { hostLimitLabel, overBy, serverMessage } from "@/lib/billing";

/**
 * The account holds more machines than its plan admits, and did not get here
 * by asking to (docs/BILLING.md §5.7). Three routes lead in: a cancellation
 * through the Stripe portal, a subscription lapsing to `unpaid`, and an admin
 * removing a comp.
 *
 * **The choice is mandatory, and it is the user's.** This modal cannot be
 * dismissed — no close button, no Escape, no click outside — because the only
 * other way to resolve the state is for someone to delete a machine on a
 * billing signal, and this product does not do that. The server holds the same
 * line from the other side: it refuses new hosts while over the limit and
 * releases none of its own accord, so nothing here is racing a background job.
 *
 * Everything the account already has keeps running the whole time. The limit
 * governs admitting a new host, never using an existing one — so this is a
 * question, asked once, not a suspension.
 *
 * Keeping **none** is a real answer and sits in the open beside the others: a
 * lapsed card is exactly the situation where someone may want to walk away
 * from all of it, and making that the hard path would be a dark pattern.
 */
export function HostLimitReconciliation() {
  const { enabled, account } = useBilling();
  const limit = account?.host_limit ?? null;
  const show = enabled && (account?.over_limit ?? false) && limit !== null;

  if (!show) return null;
  return <ReconciliationDialog keepLimit={limit} />;
}

function ReconciliationDialog({ keepLimit }: { keepLimit: number }) {
  const queryClient = useQueryClient();
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list });
  const hostList = hostsQ.data ?? [];
  const { selected, toggle, keepNone, released } = useHostKeepSelection(hostList, keepLimit);
  const mustGo = overBy({ host_count: hostList.length, host_limit: keepLimit });

  const confirm = useMutation({
    mutationFn: () => releaseHosts(released),
    onSettled: () => {
      // `/api/me` carries `over_limit`, and it is what closes this dialog.
      void queryClient.invalidateQueries({ queryKey: ["hosts"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
  });

  const releasingAll = selected.length === 0;
  const releaseCount = released.length;

  return (
    <Dialog open>
      <DialogContent
        size="lg"
        hideClose
        data-testid="over-limit-reconciliation"
        // The three ways a Radix dialog can be dismissed, all refused. A
        // reader who closes this without answering is a reader whose account
        // still cannot add a machine and is not told why.
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="shrink-0 space-y-1.5 p-4 pb-2">
          <DialogTitle className="text-base">Choose the machines you keep</DialogTitle>
          <DialogDescription className="leading-relaxed">
            Your plan now admits {hostLimitLabel(keepLimit)}
            {keepLimit === 1 ? " machine" : " machines"}, and this account holds{" "}
            <span className="font-medium tabular-nums text-foreground">{hostList.length}</span>.
            Pick the ones to keep — everything you have carries on running until you decide, and
            nothing is released except the machines you leave unchosen here.
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {hostsQ.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : hostsQ.isError ? (
            // Nothing here can be dismissed, so an empty list with no
            // explanation would be a locked door. Say what happened and offer
            // the retry.
            <div className="space-y-3 rounded-md border border-destructive/40 p-3">
              <p className="text-sm" role="alert">
                Your machines could not be loaded, so there is nothing to choose from yet. Nothing
                has been released and everything keeps running.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void hostsQ.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : (
            <HostKeepPicker
              hostList={hostList}
              keepLimit={keepLimit}
              selected={selected}
              onToggle={toggle}
              disabled={confirm.isPending}
            />
          )}
          {confirm.isError && (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {serverMessage(confirm.error) ?? "Some machines could not be released."} Nothing else
              was changed — try again.
            </p>
          )}
        </div>

        <div className="shrink-0 space-y-3 border-t border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm tabular-nums text-muted-foreground" role="status">
              {keepCountLabel(selected.length, keepLimit)}
              {mustGo > 0 && selected.length === keepLimit ? ` · ${releaseCount} to release` : ""}
            </p>
            {/* Not buried: keeping none is a valid answer, so it is a control
             * of its own rather than something you reach by unticking — and
             * it stays live with nothing ticked, because a greyed-out control
             * is how an option reads as unavailable. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={confirm.isPending}
              onClick={keepNone}
              data-testid="over-limit-keep-none"
            >
              Keep none
            </Button>
          </div>
          <Button
            type="button"
            className="w-full"
            variant={releasingAll ? "destructive" : "default"}
            disabled={confirm.isPending || hostsQ.isLoading || hostsQ.isError}
            onClick={() => confirm.mutate()}
            data-testid="over-limit-confirm"
          >
            {confirm.isPending
              ? "Releasing…"
              : releasingAll
                ? `Release all ${hostList.length} ${hostList.length === 1 ? "machine" : "machines"}`
                : `Keep ${selected.length}, release ${releaseCount}`}
          </Button>
          <p className="text-xs leading-5 text-muted-foreground">
            A released machine stops answering here and its daemon is disconnected. Its identity
            stays claimed by this account, so it can only ever come back to you — run{" "}
            <code className="font-mono">spawnd possess</code> on it again when you have room.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
