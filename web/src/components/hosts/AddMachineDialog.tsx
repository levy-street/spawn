"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { closeAddMachine, useAddMachineDialog } from "@/components/hosts/add-machine-dialog-store";
import { ConnectHostSection } from "@/components/hosts/connect-host";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBilling } from "@/hooks/useBilling";
import { hosts } from "@/lib/api";
import { atCapacity, hostsUsedLabel } from "@/lib/billing";

/**
 * Add a machine, as a modal over wherever the person already is.
 *
 * Mounted once by AppShell and opened through `openAddMachine()`: the fleet
 * page's buttons, the sidebar's New workspace when nothing is online, and
 * the Access panel's "possess a host" all land here rather than on a route,
 * so the thing they were doing is still there when the dialog closes.
 *
 * At capacity there is no ceremony to offer: the daemon would only be turned
 * away at the end of it, so the dialog says the plan is full and offers the
 * two ways past that — a bigger plan, or a released machine — and nothing
 * else. The count is the live host list, not the plan block on `/api/me`:
 * that block is cached and does not move when a machine is added or
 * released, and a stale count here would refuse a machine there is room for.
 */
export function AddMachineDialog() {
  const open = useAddMachineDialog();
  const router = useRouter();
  const pathname = usePathname();
  const { enabled: billingEnabled, account } = useBilling();
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, enabled: open });
  const plan = billingEnabled ? account : null;
  const allowance =
    plan === null
      ? null
      : { host_count: hostsQ.data?.length ?? plan.host_count, host_limit: plan.host_limit };
  const full = allowance !== null && atCapacity(allowance);
  const onFleetPage = pathname === "/legion";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeAddMachine())}>
      <DialogContent size="lg" data-testid="add-machine-dialog">
        <DialogHeader>
          <DialogTitle>Add a machine</DialogTitle>
          <DialogDescription>
            {full
              ? "This plan has no room for another machine."
              : "Install SPAWN D, approve the machine, and keep this window open until it comes online."}
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto px-4 pb-4">
          {full && plan !== null && allowance !== null && (
            <div
              className="space-y-3 rounded-lg border border-warning/50 bg-warning/5 p-3"
              data-testid="legion-capacity-notice"
            >
              <div>
                <p className="text-sm font-medium">
                  {plan.tier_name} is full at{" "}
                  <span className="tabular-nums">{hostsUsedLabel(allowance)}</span>
                </p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  A new machine would be turned away when it asks to join. To add one, move to a
                  bigger plan or release a machine you no longer use.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex flex-col gap-2 rounded-md border border-border bg-background/60 p-3">
                  <p className="text-sm font-medium">Move to a bigger plan</p>
                  <p className="flex-1 text-xs leading-5 text-muted-foreground">
                    Takes effect straight away. Come back here and the machine is admitted.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    className="self-start"
                    onClick={() => {
                      closeAddMachine();
                      openSettings("subscription");
                    }}
                  >
                    Change plan
                  </Button>
                </div>
                <div className="flex flex-col gap-2 rounded-md border border-border bg-background/60 p-3">
                  <p className="text-sm font-medium">Release a machine you no longer use</p>
                  <p className="flex-1 text-xs leading-5 text-muted-foreground">
                    Pick it from the fleet. It keeps running; it just stops answering here, and its
                    slot is freed.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="self-start"
                    onClick={() => {
                      closeAddMachine();
                      if (!onFleetPage) router.push("/legion");
                    }}
                  >
                    {onFleetPage ? "Back to the fleet" : "Open the fleet"}
                  </Button>
                </div>
              </div>
            </div>
          )}
          {!full && <ConnectHostSection frameless />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
