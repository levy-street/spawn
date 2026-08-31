import type { Metadata } from "next";
import { Colophon, Masthead } from "@/components/brand/press";
import { readBillingConfig } from "@/lib/billing-server";
import { PricingSheet } from "./pricing-sheet";

export const metadata: Metadata = {
  title: "Pricing — free for one host, priced by the rest",
  description:
    "SPAWN D charges for one thing: how many hosts your account may admit. Free for one, $5 for three, $20 for twenty, $50 for as many as you can reach. Monthly in USD, cancel any time — and self-hosting the whole stack is free and unlimited.",
};

/**
 * Which plans exist, and whether this deployment sells anything at all, are
 * per-deployment facts read from `GET /api/auth/config`. Rendering per request
 * rather than at build time is the point: a prerender would freeze whatever
 * the API said — or failed to say — on the build machine, and the build machine
 * is not the deployment.
 */
export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const billing = await readBillingConfig();
  // Fails closed: a link to the shop appears only when a server has said there
  // is one. `null` (the server could not be asked) is not a yes.
  const billingEnabled = billing?.enabled ?? false;

  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <Masthead current="pricing" billingEnabled={billingEnabled} />
      <PricingSheet
        serverEnabled={billing === null ? null : billing.enabled}
        serverTiers={billing?.tiers ?? []}
      />
      <Colophon billingEnabled={billingEnabled} />
    </main>
  );
}
