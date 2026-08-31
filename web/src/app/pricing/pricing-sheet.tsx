"use client";

import { ArrowRight, Flame } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  CTA_GHOST,
  CTA_QUIET,
  CTA_SLAB,
  Eyebrow,
  GITHUB_URL,
  RegistrationMarks,
} from "@/components/brand/press";
import type { BillingTier } from "@/lib/api";
import { useAuth, useAuthConfig } from "@/lib/auth";
import { poster } from "@/lib/fonts";
import { cn } from "@/lib/utils";
import {
  FALLBACK_TIERS,
  hostLabel,
  priceLabel,
  RECOMMENDED_TIER,
  TIER_BLURB,
  tierAction,
} from "./tiers";

/**
 * Everything on `/pricing` below the masthead.
 *
 * A client component inside a server-rendered page, for one reason: whether
 * this deployment sells anything is a fact about the *server*, and the browser
 * can read it from the same endpoint the page already read on the way out. The
 * page's own server read is the first paint (so nothing flashes on
 * spawnd.dev), and the browser's read takes over the moment it lands. On the
 * first client render the query has nothing yet, which is exactly what keeps
 * hydration honest — the same reason `useDesktopShell` reads the user agent in
 * an effect rather than during render.
 *
 * Three states, and the third is not the second:
 *
 * - `true` — the plans.
 * - `false` — a self-hosted install. No grid, no prices, no shop. §9.2.
 * - `null` — the server could not be asked. The page still has to print, so it
 *   prints the plans from the tiers it ships with.
 */
export function PricingSheet({
  serverEnabled,
  serverTiers,
}: {
  serverEnabled: boolean | null;
  serverTiers: readonly BillingTier[];
}) {
  const { config } = useAuthConfig();
  const enabled = config ? config.billing.enabled : serverEnabled;
  const advertised = config?.billing.tiers.length ? config.billing.tiers : serverTiers;
  const tiers = advertised.length > 0 ? advertised : FALLBACK_TIERS;

  if (enabled === false) return <SelfHostedSheet />;
  return <PlansSheet tiers={tiers} />;
}

/* ── The shop ─────────────────────────────────────────────────── */

function PlansSheet({ tiers }: { tiers: readonly BillingTier[] }) {
  const { user } = useAuth();
  // Signed out, every action is the same door; signed in, the plan lives in
  // Settings → Subscription, which is a modal over the app rather than a
  // route. `user` is null on the first client render — matching the HTML this
  // hydrates — and the href firms up after mount.
  const actionHref = user ? "/app" : "/signup";

  return (
    <>
      <header className="relative isolate overflow-hidden border-line-g border-b px-5 py-24 sm:px-8">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 60% 55% at 50% 0%, rgba(225,30,21,.12), transparent 60%)",
          }}
        />
        <RegistrationMarks />
        <div className="relative z-10 mx-auto w-full max-w-3xl text-center">
          <Eyebrow className="mb-5">Pricing</Eyebrow>
          <h1
            className={cn(
              poster.className,
              "mb-6 text-[clamp(36px,6.9vw,65px)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
            )}
          >
            Free for one host. <em className="text-hellfire not-italic">Priced by the rest.</em>
          </h1>
          <p className="mx-auto max-w-[58ch] text-[17px] leading-8 text-ash">
            SPAWN D charges for exactly one thing: how many hosts your account may admit. Not seats,
            not minutes, not agents, not tokens. Monthly, in US dollars, renewing until you cancel —
            and the machines you have already possessed keep working{" "}
            <em className="text-bone not-italic">whatever happens to the card</em>.
          </p>
        </div>
      </header>

      {/* ── The four plans ───────────────────────────────────── */}
      <section className="border-line-g border-b px-5 py-20 sm:px-8">
        <div className="mx-auto w-full max-w-6xl">
          <p className="mb-10 font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
            Monthly · US dollars · cancel any time
          </p>
          <div
            data-testid="pricing-tiers"
            className="grid min-w-0 gap-6 md:grid-cols-2 xl:grid-cols-4"
          >
            {tiers.map((tier) => (
              <TierCard
                key={tier.key}
                tier={tier}
                href={actionHref}
                recommended={tier.key === RECOMMENDED_TIER}
              />
            ))}
          </div>
          <p className="mt-10 max-w-[62ch] text-[15px] leading-7 text-ash">
            Already signed in? Plans live in{" "}
            <span className="text-bone">Settings → Subscription</span>, and so does cancelling.
            Nothing about billing appears anywhere else in the app until the moment you try to add a
            host past your limit.
          </p>
        </div>
      </section>

      {/* ── The three rules that decide the bill ─────────────── */}
      <section className="border-line-g border-b px-5 py-24 sm:px-8">
        <div className="mx-auto w-full max-w-6xl">
          <Eyebrow className="mb-5">Read this before you count</Eyebrow>
          <h2
            className={cn(
              poster.className,
              "mb-14 max-w-[22ch] text-[clamp(30px,4.5vw,48px)] leading-[1.02] font-light text-bone uppercase",
            )}
          >
            Three rules, and the first one is the whole thing.
          </h2>
          <div className="grid min-w-0 gap-y-12 md:grid-cols-3 md:gap-x-12">
            <Rule title="A host is a registration, not a machine.">
              The server counts rows, because rows are the only thing it can count. Running{" "}
              <code className="font-sigil text-[14px] text-ember">
                spawnd possess --new-account
              </code>{" "}
              twice on one laptop legitimately puts two host registrations on it, and both are
              counted. If you split a machine across two accounts on purpose, you have two hosts.
            </Rule>
            <Rule title="The limit governs admitting a host, never using one.">
              A machine you have already possessed keeps working forever — through a downgrade,
              through a failed payment, through a cancellation. There is no suspended state, and we
              are not building one.
            </Rule>
            <Rule title="At the limit, you choose — or you keep none.">
              Downgrade whenever you like; the plan change is never refused. You pick which hosts to
              keep and which to release, and you may keep none at all. Nothing is ever released
              without you choosing it.
            </Rule>
          </div>
        </div>
      </section>

      <SelfHostingPlate />
      <SmallPrint />
    </>
  );
}

function TierCard({
  tier,
  href,
  recommended,
}: {
  tier: BillingTier;
  href: string;
  recommended: boolean;
}) {
  const free = tier.price_cents === 0;
  const action = tierAction(tier.key);
  return (
    <article
      data-testid={`pricing-tier-${tier.key}`}
      className={cn(
        "flex min-w-0 flex-col rounded-sm border bg-char p-7",
        recommended ? "border-hellfire" : "border-line-strong",
      )}
    >
      <div className="mb-5 min-h-[18px]">{recommended ? <Eyebrow>Recommended</Eyebrow> : null}</div>
      {/* Two lines of room whether the name needs them or not: "the Legion
       * plan" wraps where the other three do not, and a row of cards whose
       * prices sit at four different heights reads as four different pages. */}
      <h3
        className={cn(
          poster.className,
          "min-h-[2.16em] text-[26px] leading-[1.08] font-light text-bone uppercase",
        )}
      >
        {tier.name}
      </h3>
      <p className="mt-4 flex items-baseline gap-2">
        <span className={cn(poster.className, "text-[40px] leading-none font-light text-bone")}>
          {priceLabel(tier.price_cents)}
        </span>
        <span className="font-sigil text-[11px] tracking-[0.18em] text-ash uppercase">
          {free ? "forever" : "/ month"}
        </span>
      </p>
      <p className="mt-2 font-sigil text-[12px] tracking-[0.18em] text-ember uppercase">
        {hostLabel(tier.host_limit)}
      </p>
      <p className="mt-5 flex-1 text-[15px] leading-7 text-ash">{TIER_BLURB[tier.key] ?? ""}</p>
      {/* One slab on the row, and it belongs to the recommended column. The
       * other three take the same shape and measure in the card's own ground,
       * so the four actions line up instead of arguing. */}
      <Link href={href} className={cn("mt-8 w-full", recommended ? CTA_SLAB : CTA_GHOST)}>
        {action}
        {recommended ? (
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        ) : null}
      </Link>
    </article>
  );
}

function Rule({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-line-strong border-t-2 pt-6">
      <h3
        className={cn(
          poster.className,
          "mb-3 text-[22px] leading-[1.1] font-light text-bone uppercase",
        )}
      >
        {title}
      </h3>
      <p className="max-w-[44ch] text-[16px] leading-7 text-ash">{children}</p>
    </div>
  );
}

/**
 * The plate, spent on the one claim that deserves it. A pricing page's boldest
 * statement is that you never have to be on it.
 */
function SelfHostingPlate() {
  return (
    <section className="relative overflow-hidden bg-plate text-void">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-20 -right-20 size-[16rem] rotate-[4deg] opacity-[0.10] sm:size-[22rem]"
      >
        {/* biome-ignore lint/performance/noImgElement: decorative stamp, no optimization needed */}
        <img src="/brand/spawnd-icon-black.svg" alt="" className="size-full" />
      </div>
      <div className="relative mx-auto w-full max-w-6xl px-5 py-24 sm:px-8">
        <p className="mb-5 font-sigil text-[12px] font-medium tracking-[0.3em] uppercase">
          The escape hatch
        </p>
        <h2
          className={cn(
            poster.className,
            "mb-6 max-w-[20ch] text-[clamp(30px,4.8vw,52px)] leading-[1.0] font-light uppercase",
          )}
        >
          Host it yourself. Free, unlimited, forever.
        </h2>
        <p className="max-w-[62ch] text-[17px] leading-8">
          Every price above buys one thing: our servers introducing your browser to your daemon. You
          do not have to use ours. SPAWN D is open source end to end, and a stack you run has no
          plan, no host limit, and no billing code path at all — this page does not even render a
          shop there. The trust document names self-hosting as the answer for anyone the retained
          metadata bothers, and this is that answer with a price on it: none.
        </p>
        <div className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-7">
          <Link href="/download" className={CTA_SLAB}>
            Install the daemon
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={CTA_GHOST}>
            Read the source
          </a>
        </div>
      </div>
    </section>
  );
}

function SmallPrint() {
  return (
    <section className="px-5 py-24 sm:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <Eyebrow className="mb-5">The small print</Eyebrow>
        <h2
          className={cn(
            poster.className,
            "mb-10 max-w-[20ch] text-[clamp(26px,3.5vw,39px)] leading-[1.04] font-light text-bone uppercase",
          )}
        >
          Everything a price has to say out loud.
        </h2>
        <ul className="space-y-4 text-[16px] leading-7 text-ash">
          <Note>
            Subscriptions are billed monthly in US dollars and renew automatically until you cancel.
            There is no annual plan, no trial, no per-seat charge and no metered usage.
          </Note>
          <Note>
            Prices are in US dollars. Where tax applies, the amount is shown at checkout before you
            pay.
          </Note>
          <Note>
            Cancel any time from <span className="text-bone">Settings → Subscription</span>. A
            cancellation runs to the end of the period you have already paid for; a downgrade takes
            effect immediately, and you choose which hosts to keep when it does.
          </Note>
          <Note>
            Payments are taken by Stripe. Card details are entered on Stripe's own checkout and
            never reach our servers.
          </Note>
          <Note>
            Consumers in the EU and the UK have a 14-day right to withdraw from a digital-services
            contract.{" "}
            <Link
              href="/terms#withdrawal"
              className="text-bone underline decoration-ember/70 underline-offset-4 transition-colors hover:text-ember"
            >
              Withdraw from contract
            </Link>
            .
          </Note>
        </ul>
        <div className="mt-12 flex flex-wrap items-center gap-x-7 gap-y-3">
          <Link href="/terms" className={CTA_QUIET}>
            Terms of service
          </Link>
          <Link href="/privacy" className={CTA_QUIET}>
            Privacy policy
          </Link>
        </div>
      </div>
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <Flame className="mt-1.5 size-3 shrink-0 text-ash" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

/* ── No shop here ─────────────────────────────────────────────── */

/**
 * What `/pricing` is on a self-hosted install: not an error, not an empty
 * grid, and above all not a shop. Billing off is a supported state, and the
 * honest thing to print is what that state actually means.
 */
function SelfHostedSheet() {
  return (
    <>
      <header className="relative isolate overflow-hidden border-line-g border-b px-5 py-24 sm:px-8">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 60% 55% at 50% 0%, rgba(225,30,21,.12), transparent 60%)",
          }}
        />
        <RegistrationMarks />
        <div className="relative z-10 mx-auto w-full max-w-3xl text-center">
          <Eyebrow className="mb-5">Self-hosted</Eyebrow>
          <h1
            className={cn(
              poster.className,
              "mb-6 text-[clamp(36px,6.9vw,65px)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
            )}
          >
            Nothing here <em className="text-hellfire not-italic">is for sale.</em>
          </h1>
          <p className="mx-auto max-w-[58ch] text-[17px] leading-8 text-ash">
            This deployment of SPAWN D runs without billing. There is no plan, no limit on how many
            hosts you may possess, and nothing on this page to buy. That is not a page that failed
            to load — it is what a self-hosted install looks like.
          </p>
        </div>
      </header>

      <section data-testid="pricing-self-hosted" className="px-5 py-24 sm:px-8">
        <div className="mx-auto w-full max-w-3xl">
          <ul className="space-y-4 text-[16px] leading-7 text-ash">
            <Note>
              Hosts are unlimited. Possess as many machines as you can reach; no count is kept
              against you and no plan applies.
            </Note>
            <Note>
              This server has no billing API. Those routes are not registered at all, so there is
              nothing here that could take a payment even by accident.
            </Note>
            <Note>
              No subscription data exists on this deployment — no customer record, no plan, no
              renewal date. There is nothing to store, so nothing is stored.
            </Note>
          </ul>
          <p className="mt-10 max-w-[62ch] text-[16px] leading-7 text-ash">
            If you were sent here from somewhere that sells subscriptions, that was a different
            deployment. Want one of your own? The whole stack is open source and runs on machines
            you control.
          </p>
          <div className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-7">
            <Link href="/download" className={CTA_SLAB}>
              Install the daemon
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={CTA_QUIET}>
              Read the source
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
