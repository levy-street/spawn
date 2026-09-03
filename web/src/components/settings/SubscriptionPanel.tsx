"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { PlanChangeDialog } from "@/components/settings/plan-change-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBilling, useBillingState } from "@/hooks/useBilling";
import { ApiError, billing } from "@/lib/api";
import {
  atCapacity,
  type HostAllowance,
  hostLimitLabel,
  hostsUsedLabel,
  overBy,
  periodNotice,
  planArt,
} from "@/lib/billing";
import { leaveForBilling } from "@/lib/billing-return";
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
    onSuccess: ({ url }) => leaveForBilling(url),
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
  const full = atCapacity(plan);
  const art = planArt(plan.tier);

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Subscription</h2>
        <p className="text-sm text-muted-foreground">
          What this account is on, and what it is using.
        </p>
      </div>

      {/* The plan, as a plate: the tier's ink behind the figures, fading into
       * the card so the numbers stay legible on top of it in either theme. */}
      <div className="relative isolate overflow-hidden rounded-xl border border-border bg-card">
        {/* The ink owns the right half; the figures own the left. On the
         * pressroom's near-black card the plate's own black disappears and
         * only the red drawing is left standing behind the numbers. */}
        {art !== null && (
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
            <div className="absolute inset-y-0 right-0 w-full sm:w-[64%]">
              {/* biome-ignore lint/performance/noImgElement: static brand art, no optimisation needed */}
              <img
                src={art}
                alt=""
                className="size-full object-cover object-[70%_35%] opacity-90"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-card via-card/35 via-40% to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-t from-card/90 via-transparent to-transparent" />
            </div>
            <div className="absolute -top-24 -left-24 size-72 rounded-full bg-brand-accent/15 blur-3xl" />
          </div>
        )}

        <div className="relative space-y-5 p-5 sm:max-w-[58%]">
          <div>
            <p className="font-mono text-[11px] tracking-[0.2em] text-muted-foreground uppercase">
              Plan
            </p>
            {/* App chrome, so the app's own face: weight and tabular figures
             * carry the emphasis, never the poster type. */}
            <p
              className="mt-1 text-4xl font-semibold tracking-tight"
              data-testid="subscription-tier"
            >
              {plan.tier_name}
            </p>
            {state.isLoading && state.data === undefined ? (
              <Skeleton className="mt-2 h-4 w-48" />
            ) : period !== null ? (
              <p className="mt-1 text-sm text-muted-foreground" data-testid="subscription-period">
                {period.tone === "ends"
                  ? `Cancelled — this plan ends on ${formatDate(period.at)}.`
                  : `Renews on ${formatDate(period.at)}.`}
              </p>
            ) : null}
          </div>

          <div className="max-w-64">
            <p className="font-mono text-[11px] tracking-[0.2em] text-muted-foreground uppercase">
              Machines
            </p>
            <p
              className={cn(
                "mt-1 text-2xl font-semibold tracking-tight tabular-nums",
                full && "text-brand-accent",
              )}
              data-testid="subscription-hosts"
            >
              {hostsUsedLabel(plan)}
            </p>
            <HostMeter host_count={plan.host_count} host_limit={plan.host_limit} />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {plan.host_limit === null
                ? "No ceiling on this plan."
                : full
                  ? "Every slot is taken. The next machine needs room first."
                  : `Room for ${plan.host_limit - plan.host_count} more.`}
            </p>
          </div>

          {excess > 0 && (
            <p
              className="rounded-md border border-warning/50 bg-background/60 px-3 py-2 text-sm leading-6 backdrop-blur"
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
            Hosts are counted as registrations, not computers: possess one machine under two
            accounts and it counts as two. {plan.tier_name} admits{" "}
            <span className="tabular-nums">{hostLimitLabel(plan.host_limit)}</span>.
          </p>
        </div>
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

/**
 * The allowance as a row of slots: one per host the plan admits, filled for
 * each machine held. Over the limit, the extra machines get their own slots
 * so the bar reads "more than fits" rather than quietly clamping. Unlimited
 * has nothing to count against, so it is drawn as an open run instead.
 */
function HostMeter({ host_count, host_limit }: HostAllowance) {
  if (host_limit === null) {
    return (
      <div
        aria-hidden
        className="mt-2 h-1.5 w-full rounded-full bg-gradient-to-r from-brand-accent via-brand-accent/60 to-transparent"
      />
    );
  }
  const slots = Math.max(host_limit, host_count);
  return (
    <div aria-hidden className="mt-2 flex gap-1">
      {Array.from({ length: slots }, (_, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: slots are positional and never reorder
          key={index}
          className={cn(
            "h-1.5 min-w-1 flex-1 rounded-full transition-colors",
            index < host_count ? "bg-brand-accent" : "bg-border",
            index >= host_limit && "ring-1 ring-warning",
          )}
        />
      ))}
    </div>
  );
}
