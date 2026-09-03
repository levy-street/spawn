"use client";

import { useQuery } from "@tanstack/react-query";
import { type BillingState, type BillingTier, billing, type UserBilling } from "@/lib/api";
import { useAuth, useAuthConfig } from "@/lib/auth";

/**
 * Whether this deployment has billing at all, and what this account's plan is.
 *
 * The gate is deliberately doubled. `/api/auth/config` advertises the exact
 * condition the server enforces, and `/api/me` carries the account's own block
 * — which a self-hosted server never populates. Either one saying no means no,
 * so a client cannot draw a paywall a server would not apply, and a
 * self-hoster's app is byte-for-byte the app they had before billing existed.
 *
 * Every billing surface starts here. `enabled === false` is the whole answer:
 * render nothing, ask nothing, and do not fetch `/api/billing/*` (those routes
 * 404 on a deployment with billing off, which is the point).
 */
export interface Billing {
  enabled: boolean;
  /** The account's plan block, or null when there is no billing here. */
  account: UserBilling | null;
  /** The tiers this deployment sells, for a plan chooser. Empty when disabled. */
  tiers: BillingTier[];
  /** True only once both reads have resolved; guards a flash of the wrong UI. */
  ready: boolean;
}

export function useBilling(): Billing {
  const { user, loading: userLoading } = useAuth();
  const { config, loading: configLoading } = useAuthConfig();
  const advertised = config?.billing.enabled ?? false;
  const account = user?.billing ?? null;
  const enabled = advertised && (account?.enabled ?? false);

  return {
    enabled,
    account: enabled ? account : null,
    tiers: enabled ? (config?.billing.tiers ?? []) : [],
    ready: !userLoading && !configLoading,
  };
}

/**
 * `GET /api/billing/state` — the one read every plan surface uses, and the
 * only one carrying `has_subscription`, which is what separates "change your
 * plan" from "start one".
 *
 * Gated on {@link useBilling} so it is never issued against a server that
 * would 404 it.
 */
export function useBillingState(enabled: boolean) {
  return useQuery<BillingState>({
    queryKey: ["billing", "state"],
    queryFn: billing.state,
    enabled,
    staleTime: 30_000,
  });
}
