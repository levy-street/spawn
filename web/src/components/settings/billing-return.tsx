"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { toast } from "@/components/ui/toast";
import {
  parseBillingReturn,
  takeBillingReturnHere,
  withoutBillingParam,
} from "@/lib/billing-return";

/**
 * Entitlement is written by the webhook, which usually lands within a second
 * or two of the browser coming back — but not before it. Re-read the plan a
 * few times so the panel catches up on its own rather than showing the old
 * tier until somebody reloads.
 */
const RECHECK_DELAYS_MS = [1_500, 4_000, 10_000];

/**
 * The other half of `leaveForBilling`: Stripe has sent the browser back to
 * `/app?billing=…`, and this turns that into "where you were, with the plan
 * panel open" (docs/BILLING.md §4.6).
 *
 * Mounted by AppShell, so it runs on whichever page the return lands on. The
 * flag is stripped from the URL before anything else so that a reload, or
 * the navigation below, cannot replay it; the settings store is a module
 * singleton, so opening the panel here survives the route change.
 */
export function BillingReturnHandler() {
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => {
    const kind = parseBillingReturn(window.location.search);
    if (kind === null) return;

    window.history.replaceState(
      window.history.state,
      "",
      withoutBillingParam(window.location.pathname, window.location.search),
    );

    const here = `${window.location.pathname}${window.location.search}`;
    const back = takeBillingReturnHere();
    if (back !== null && back !== here) router.replace(back);
    openSettings("subscription");

    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["billing"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["hosts"] });
    };
    refresh();
    if (kind !== "cancelled") {
      // Deliberately not cleared on unmount: the navigation above unmounts
      // this shell, and the re-reads are the point. The query client outlives
      // the page, so a late invalidation is harmless.
      for (const delay of RECHECK_DELAYS_MS) setTimeout(refresh, delay);
    }

    if (kind === "complete") {
      toast("Payment received. Your plan updates as soon as Stripe confirms it.");
    } else if (kind === "cancelled") {
      toast("Checkout cancelled. Nothing was charged and nothing has changed.");
    }
  }, [router, queryClient]);

  return null;
}
