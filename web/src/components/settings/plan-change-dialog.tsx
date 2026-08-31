"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  HostKeepPicker,
  keepCountLabel,
  releaseHosts,
  useHostKeepSelection,
} from "@/components/hosts/host-keep-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { type BillingTier, billing, hosts } from "@/lib/api";
import {
  hostLimitLabel,
  hostSelectionRequired,
  type LimitFacts,
  planDirection,
  priceLabel,
  serverMessage,
  subscriptionRequired,
} from "@/lib/billing";
import { cn } from "@/lib/utils";

/**
 * Changing plans, and — when a smaller plan will not hold what the account
 * already has — choosing which machines to keep (docs/BILLING.md §5.6).
 *
 * Plan switching is turned off in the Stripe Customer Portal deliberately. The
 * portal would let someone downgrade without ever consulting us, and leave
 * them over their limit with no chance to choose. Owning this dialog is what
 * makes "the downgrade is always allowed, they just pick what to keep"
 * implementable at all.
 *
 * The order inside a downgrade is load-bearing: the hosts the user let go are
 * released FIRST, and only then does Stripe hear about the plan. A payment
 * that fails after that leaves them on the old plan with fewer machines —
 * recoverable and honest — rather than on a cheaper one while still over its
 * limit.
 *
 * **Downgrades apply immediately, not at period end**, and there is no "takes
 * effect on…" affordance anywhere here. Deferring a decrease materialises a
 * Stripe subscription schedule, and a subscription with a scheduled update
 * cannot be changed or cancelled by its customer — a month-long lockout, in
 * exchange for nothing, because the selection step has already answered the
 * over-limit question.
 */
export function PlanChangeDialog({
  open,
  onOpenChange,
  tiers,
  currentTier,
  hasSubscription,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tiers: readonly BillingTier[];
  currentTier: string;
  hasSubscription: boolean;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<string | null>(null);
  const [selection, setSelection] = useState<LimitFacts | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Free is where a subscription ends, not somewhere to move to: cancelling
  // lives in the portal, and the reconciliation modal catches whatever the
  // account is holding afterwards (§5.7).
  const choices = tiers.filter((tier) => tier.price_cents > 0);

  const reset = () => {
    setTarget(null);
    setSelection(null);
    setError(null);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: ["billing"] });
    void queryClient.invalidateQueries({ queryKey: ["me"] });
    void queryClient.invalidateQueries({ queryKey: ["hosts"] });
  };

  const failed = (cause: unknown) => {
    setError(
      serverMessage(cause) ??
        "That plan change could not be completed. Nothing was charged and nothing has changed.",
    );
  };

  const submit = useMutation({
    mutationFn: async (tier: string) => {
      if (hasSubscription) {
        try {
          await billing.changePlan(tier);
          return { kind: "changed" } as const;
        } catch (cause) {
          // A row Stripe has itself given up on — cancelled, or lapsed to
          // `unpaid`. There is nothing to move, and the server's own answer to
          // that is Checkout, so fall through to it rather than reporting a
          // failure the reader can do nothing with.
          if (!subscriptionRequired(cause)) throw cause;
        }
      }
      const { url } = await billing.checkout(tier);
      return { kind: "checkout", url } as const;
    },
    onMutate: () => setError(null),
    onSuccess: (result) => {
      if (result.kind === "checkout") {
        window.location.assign(result.url);
        return;
      }
      settle();
      close();
    },
    onError: (cause) => {
      const facts = hostSelectionRequired(cause);
      // Not a refusal — the server asking which machines to keep.
      if (facts !== null && facts.host_limit !== null) {
        setSelection(facts);
        return;
      }
      failed(cause);
    },
  });

  const activeTier = selection?.tier ?? target ?? "";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="lg" data-testid="plan-change-dialog">
        {selection === null ? (
          <ChooseStep
            choices={choices}
            currentTier={currentTier}
            hasSubscription={hasSubscription}
            target={target}
            onTarget={setTarget}
            busy={submit.isPending}
            error={error}
            onCancel={close}
            onConfirm={() => target !== null && submit.mutate(target)}
          />
        ) : (
          <SelectHostsStep
            facts={selection}
            tierName={choices.find((tier) => tier.key === activeTier)?.name ?? activeTier}
            onBack={() => {
              setSelection(null);
              setError(null);
            }}
            onDone={() => {
              settle();
              close();
            }}
            onFailed={failed}
            error={error}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChooseStep({
  choices,
  currentTier,
  hasSubscription,
  target,
  onTarget,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  choices: readonly BillingTier[];
  currentTier: string;
  hasSubscription: boolean;
  target: string | null;
  onTarget: (tier: string) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const direction = target === null ? "same" : planDirection(currentTier, target, choices);

  return (
    <>
      <div className="shrink-0 space-y-1.5 p-4 pb-2 pr-12">
        <DialogTitle className="text-base">
          {hasSubscription ? "Change plan" : "Choose a plan"}
        </DialogTitle>
        <DialogDescription>
          Monthly, in USD, renewing until you cancel. A host is a registration, not a machine.
        </DialogDescription>
      </div>

      <fieldset className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4">
        <legend className="sr-only">Plans</legend>
        {choices.map((tier) => {
          const current = tier.key === currentTier;
          const checked = target === tier.key;
          return (
            <label
              key={tier.key}
              className={cn(
                "flex items-center gap-3 rounded-md border p-3 transition-colors",
                current
                  ? "cursor-default border-border bg-muted/40"
                  : checked
                    ? "cursor-pointer border-brand-accent/60 bg-accent/40"
                    : "cursor-pointer border-border hover:bg-accent/20",
              )}
            >
              <input
                type="radio"
                name="plan-tier"
                value={tier.key}
                checked={checked}
                disabled={current || busy}
                onChange={() => onTarget(tier.key)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium">{tier.name}</span>
                  {current && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      current plan
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {/* Weight and tabular figures carry the emphasis; the poster
                   * face stays on marketing surfaces. */}
                  <span className="font-medium tabular-nums text-foreground">
                    {priceLabel(tier.price_cents)}
                  </span>{" "}
                  · {hostLimitLabel(tier.host_limit)} {tier.host_limit === 1 ? "host" : "hosts"}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="shrink-0 space-y-3 border-t border-border p-4">
        {direction !== "same" && (
          <p className="text-xs leading-5 text-muted-foreground">
            {direction === "upgrade"
              ? "Applies immediately. You are charged the difference for the rest of this month."
              : "Applies immediately, not at the end of the month. The unused part of what you have paid is credited against your next invoice, and if this plan holds fewer machines than you have, you choose which to keep next."}
          </p>
        )}
        {hasSubscription && (
          <p className="text-xs leading-5 text-muted-foreground">
            To end your subscription altogether, use Manage billing.
          </p>
        )}
        {error !== null && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={target === null || busy}
            onClick={onConfirm}
            data-testid="plan-change-confirm"
          >
            {/* Standard verbs, chosen by what the click actually does. */}
            {busy ? "Working…" : direction === "downgrade" ? "Change plan" : "Upgrade"}
          </Button>
        </div>
      </div>
    </>
  );
}

/**
 * The selection step: exactly as many machines as the new plan admits, chosen
 * by a person, released before Stripe is told anything.
 */
function SelectHostsStep({
  facts,
  tierName,
  onBack,
  onDone,
  onFailed,
  error,
}: {
  facts: LimitFacts;
  tierName: string;
  onBack: () => void;
  onDone: () => void;
  onFailed: (cause: unknown) => void;
  error: string | null;
}) {
  const keepLimit = facts.host_limit ?? 0;
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list });
  const hostList = hostsQ.data ?? [];
  const { selected, toggle, released } = useHostKeepSelection(hostList, keepLimit);

  const apply = useMutation({
    mutationFn: async () => {
      await releaseHosts(released);
      await billing.changePlan(facts.tier);
    },
    onSuccess: onDone,
    onError: onFailed,
  });

  const ready = selected.length === keepLimit;

  return (
    <>
      <div className="shrink-0 space-y-1.5 p-4 pb-2 pr-12">
        <DialogTitle className="text-base">Choose the machines you keep</DialogTitle>
        <DialogDescription className="leading-relaxed">
          {tierName} admits {hostLimitLabel(facts.host_limit)}
          {keepLimit === 1 ? " machine" : " machines"}, and this account holds{" "}
          <span className="font-medium tabular-nums text-foreground">{facts.host_count}</span>. Pick
          the {keepLimit === 1 ? "one" : keepLimit} to keep; the rest are released when you confirm,
          before the plan changes.
        </DialogDescription>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {hostsQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : (
          <HostKeepPicker
            hostList={hostList}
            keepLimit={keepLimit}
            selected={selected}
            onToggle={toggle}
            disabled={apply.isPending}
          />
        )}
      </div>

      <div className="shrink-0 space-y-3 border-t border-border p-4">
        <p className="text-sm tabular-nums text-muted-foreground" role="status">
          {keepCountLabel(selected.length, keepLimit)}
        </p>
        {error !== null && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onBack} disabled={apply.isPending}>
            Back
          </Button>
          <Button
            type="button"
            disabled={!ready || apply.isPending}
            onClick={() => apply.mutate()}
            data-testid="plan-change-release-confirm"
          >
            {apply.isPending ? "Releasing…" : `Release ${released.length} and change plan`}
          </Button>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          A released machine keeps running; it just stops answering here, and its identity stays
          claimed by this account so it can only ever come back to you.
        </p>
      </div>
    </>
  );
}
