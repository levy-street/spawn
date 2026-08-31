"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { PlanChangeDialog } from "@/components/settings/plan-change-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBilling, useBillingState } from "@/hooks/useBilling";
import { ApiError, billing } from "@/lib/api";
import { atCapacity, hostLimitLabel, hostsUsedLabel, overBy, periodNotice } from "@/lib/billing";
import { cn } from "@/lib/utils";

function formatDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Settings → Subscription: what this account is on, what it is using, and the
 * three things a person can do about it.
 *
 * With the pricing page, this is the only place billing exists unprompted —
 * no plan badge in the nav, no upsell in the sidebar, no nag. The app says
 * nothing about money until the moment it must (docs/BILLING.md §1.2 rule 4).
 *
 * The tab that renders this is hidden entirely where the deployment has no
 * billing, so nothing here needs a self-hosted branch; it still refuses to
 * draw on a null plan block rather than inventing a Free tier for one.
 */
export function SubscriptionPanel() {
  const { enabled, account, tiers } = useBilling();
  const state = useBillingState(enabled);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const portal = useMutation({
    mutationFn: () => billing.portal(),
    onMutate: () => setError(null),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : "Could not open the billing portal."),
  });

  if (!enabled || account === null) return null;

  // The live read wins where it has arrived; the block on `/api/me` is what
  // keeps the panel from being blank for a beat on open.
  const plan = state.data ?? account;
  const hasSubscription = state.data?.has_subscription ?? account.status !== null;
  const period = periodNotice(plan);
  const excess = overBy(plan);

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Subscription</h2>
        <p className="text-sm text-muted-foreground">
          What this account is on, and what it is using.
        </p>
      </div>

      <div className="space-y-4 rounded-md border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Plan</p>
            <p className="mt-0.5 text-lg font-semibold" data-testid="subscription-tier">
              {plan.tier_name}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Machines</p>
            {/* App chrome, so the app's own face: weight and tabular figures
             * carry the emphasis, never the poster type. */}
            <p
              className={cn(
                "mt-0.5 text-lg font-semibold tabular-nums",
                atCapacity(plan) && "text-brand-accent",
              )}
              data-testid="subscription-hosts"
            >
              {hostsUsedLabel(plan)}
            </p>
          </div>
        </div>

        {state.isLoading && state.data === undefined && <Skeleton className="h-4 w-48" />}

        {period !== null && (
          <p className="text-sm text-muted-foreground" data-testid="subscription-period">
            {period.tone === "ends"
              ? `Cancelled — this plan ends on ${formatDate(period.at)}.`
              : `Renews on ${formatDate(period.at)}.`}
          </p>
        )}

        {excess > 0 && (
          <p
            className="rounded-md border border-warning/50 px-3 py-2 text-sm leading-6"
            data-testid="subscription-over-limit"
          >
            This account holds {excess} more{" "}
            {excess === 1 ? "machine than this plan admits" : "machines than this plan admits"}.
            They all keep running, and no new machine can be added until you choose which to keep.
          </p>
        )}

        {error !== null && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {hasSubscription ? (
            <>
              <Button type="button" onClick={() => setChanging(true)}>
                Change plan
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={portal.isPending}
                onClick={() => portal.mutate()}
              >
                {portal.isPending ? "Opening…" : "Manage billing"}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              onClick={() => setChanging(true)}
              data-testid="subscription-upgrade"
            >
              Upgrade
            </Button>
          )}
        </div>

        <p className="text-xs leading-5 text-muted-foreground">
          A host is a registration, not a machine: possessing one computer twice under different
          accounts counts twice. Your current plan admits{" "}
          <span className="tabular-nums">{hostLimitLabel(plan.host_limit)}</span>.
        </p>
      </div>

      <PlanChangeDialog
        open={changing}
        onOpenChange={setChanging}
        tiers={state.data?.tiers.length ? state.data.tiers : tiers}
        currentTier={plan.tier}
        hasSubscription={hasSubscription}
      />
    </section>
  );
}
