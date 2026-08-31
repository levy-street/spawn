import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Colophon, Eyebrow, Masthead, RegistrationMarks } from "@/components/brand/press";
import { readBillingConfig } from "@/lib/billing-server";
import { poster } from "@/lib/fonts";
import { cn } from "@/lib/utils";

/*
 * Terms of service.
 *
 * This page is a *draft* until the owner signs it off. Everything the owner
 * alone can decide — the contracting entity, the jurisdiction, the contact
 * address, the refund position, the liability cap — is marked with `Pending`
 * and rendered as a visible bracketed placeholder rather than invented. A
 * plausible-looking company name in a contract is worse than an obvious gap:
 * the gap gets filled, the invention gets shipped.
 *
 * `/privacy` is the sibling of this page and the two must agree; a change to
 * how cancellation, renewal or data deletion works belongs in both.
 */

export const metadata: Metadata = {
  title: "Terms of service",
  description:
    "The agreement covering SPAWN D accounts and subscriptions: what the service is, how billing and renewal work, how to cancel, the EU and UK right of withdrawal, and the limits of what is promised.",
};

// The pricing link in the masthead and colophon is billing-conditional and
// fails closed; the legal pages themselves are not — they exist on every
// deployment, self-hosted included.
export const dynamic = "force-dynamic";

export default async function TermsPage() {
  const billing = await readBillingConfig();
  const billingEnabled = billing?.enabled ?? false;

  return (
    <main className="grimoire min-h-vv overflow-x-clip">
      <Masthead billingEnabled={billingEnabled} />

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
          <Eyebrow className="mb-5">Terms of service</Eyebrow>
          <h1
            className={cn(
              poster.className,
              "mb-6 text-[clamp(32px,6vw,58px)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
            )}
          >
            The whole bargain, <em className="text-hellfire not-italic">in plain words.</em>
          </h1>
          <p className="mx-auto max-w-[58ch] text-[17px] leading-8 text-ash">
            What you get, what it costs, how to stop, and what we do not promise. Read it once; it
            is shorter than the software.
          </p>
          <p className="mt-6 font-sigil text-[11px] tracking-[0.18em] text-ash uppercase">
            In force from <Pending>[EFFECTIVE DATE]</Pending>
          </p>
        </div>
      </header>

      <DraftBanner />

      <div className="mx-auto w-full max-w-3xl px-5 pt-16 pb-24 sm:px-8">
        <Clause n="1" title="Who you are contracting with">
          <p>
            These terms are an agreement between you and <Pending>[LEGAL ENTITY NAME]</Pending>,
            registered at <Pending>[REGISTERED ADDRESS]</Pending> ("we", "us"), the operator of the
            SPAWN D hosted service at spawnd.dev. Reach us at <Pending>[CONTACT ADDRESS]</Pending>.
          </p>
          <p>
            They cover the hosted service and any subscription bought through it. They do not cover
            the SPAWN D source code itself, which is published under the MIT and Apache-2.0
            licences; a copy you run on your own machines is governed by those licences and by
            nothing on this page.
          </p>
        </Clause>

        <Clause n="2" title="What the service is">
          <p>
            SPAWN D is a control plane. It introduces a browser or phone you are signed in on to a
            daemon running on a computer you possess, then carries the account, host and session
            metadata needed to keep doing that. Terminal traffic is encrypted end to end between
            those two endpoints; the service is not designed to read it and is not able to. What the
            service does hold is inventoried in the <Inline href="/privacy">privacy policy</Inline>.
          </p>
          <p>
            The daemon runs on your hardware, under your account, and does what you and the agents
            you launch tell it to. We do not operate your machines and we do not supervise what runs
            on them.
          </p>
        </Clause>

        <Clause n="3" title="Your account">
          <p>
            You need an account to use the hosted service, and you must give an email address that
            reaches you. You are responsible for what happens under your account, including keeping
            your credentials and your devices' approvals under your own control. Tell us promptly at{" "}
            <Pending>[CONTACT ADDRESS]</Pending> if you believe someone else has access to it.
          </p>
          <p>You must be old enough to enter a contract where you live.</p>
        </Clause>

        <Clause n="4" title="Subscriptions, price and renewal">
          <p>
            Paid plans are sold as monthly subscriptions in US dollars. The price and the number of
            hosts each plan admits are shown on the <Inline href="/pricing">pricing page</Inline> at
            the time you subscribe. A subscription renews automatically every month, at the
            then-current price, until it is cancelled.
          </p>
          <p>
            A plan governs how many hosts your account may{" "}
            <em className="not-italic text-bone">admit</em>. A host is a registration, not a
            machine, and a computer you have already possessed keeps working regardless of your
            plan, a failed payment, or a cancellation.
          </p>
          <p>
            Payments are processed by Stripe. Card details are entered on Stripe's own checkout and
            do not reach our servers. Where tax applies to your purchase, the amount is shown at
            checkout before you pay.
          </p>
          <p>
            We may change prices. A change never applies to a period you have already paid for, and
            we will tell you before a renewal at a new price. If you do not want the new price,
            cancel before that renewal.
          </p>
        </Clause>

        <Clause n="5" title="Changing plans and cancelling">
          <p>
            Cancel any time from <em className="not-italic text-bone">Settings → Subscription</em>{" "}
            in the app. A cancellation takes effect at the end of the period you have already paid
            for; you keep the plan you paid for until then and are not billed again.
          </p>
          <p>
            A downgrade takes effect immediately. Where the new plan admits fewer hosts than you
            have registered, you choose which registrations to keep and which to release — you may
            also keep none. Nothing is released without you choosing it, and a plan change is never
            refused because of the number of hosts you have.
          </p>
        </Clause>

        <Clause n="6" title="Refunds">
          <p>
            <Pending>
              [REFUND POLICY — owner to set. The draft below is the default position and must be
              confirmed or replaced before this page goes live.]
            </Pending>
          </p>
          <p>
            Outside the statutory rights described in section 7, payments for a period already begun
            are non-refundable, and cancelling stops the next renewal rather than refunding the
            current month. Nothing here limits any right you have under the consumer law of where
            you live.
          </p>
        </Clause>

        <section id="withdrawal" className="scroll-mt-24">
          <Clause n="7" title="Right of withdrawal (EU and UK consumers)">
            <p>
              If you are a consumer in the European Union or the United Kingdom, you have 14 days
              from the day the contract is concluded to withdraw from it without giving a reason.
            </p>
            <p>
              Because a subscription gives you access straight away, you are asked at checkout to
              request that we begin supplying the service during the withdrawal period, and to
              acknowledge that you lose the right of withdrawal once the service has been fully
              supplied. If you withdraw after supply has begun but before the period has run, you
              pay a proportionate amount for what was supplied up to the moment you told us.
            </p>
            <WithdrawalFunction />
            <p className="text-[15px]">
              You may use the model form below, but you do not have to — any unambiguous statement
              that you are withdrawing is enough. We will confirm receipt on a durable medium
              without undue delay, and refund what is due within 14 days of being told, using the
              same means of payment you used.
            </p>
            <ModelForm />
          </Clause>
        </section>

        <Clause n="8" title="Acceptable use">
          <p>You agree not to use the hosted service to:</p>
          <ul className="mt-4 space-y-2.5 pl-5 text-[16px] leading-7 text-ash [&>li]:list-disc">
            <li>break the law, or help someone else break it;</li>
            <li>
              attack, overload, probe or disrupt the service, or anyone else's use of it, or attempt
              to reach an account, host or session that is not yours;
            </li>
            <li>
              work around the host limit on your plan by any means other than buying a plan that
              admits more, or resell access to the hosted service as your own;
            </li>
            <li>
              possess a computer you are not authorised to control, or run agents on it that you are
              not authorised to run.
            </li>
          </ul>
          <p>
            You are responsible for what your agents do on your hosts. An automated actor acting
            under your account is you, for the purposes of these terms.
          </p>
        </Clause>

        <Clause n="9" title="Availability and changes">
          <p>
            The hosted service is provided as it is, without an uptime commitment. We may change,
            add to, or withdraw parts of it, and we may take it down for maintenance. Where a change
            materially reduces what a paid plan gets, you may cancel and we will refund the unused
            part of the period you paid for.
          </p>
          <p>
            The service depends on your own machines and your own network. Nothing here promises
            that a host of yours will be reachable.
          </p>
        </Clause>

        <Clause n="10" title="Liability">
          <p>
            To the fullest extent the law allows, we are not liable for indirect or consequential
            loss, for lost profits or revenue, or for loss or corruption of data on machines we do
            not operate — which is all of yours. Our total liability arising out of these terms is
            limited to <Pending>[LIABILITY CAP — owner to set]</Pending>.
          </p>
          <p>
            Nothing in these terms excludes liability that cannot lawfully be excluded, including
            for death or personal injury caused by negligence, for fraud, or under the consumer law
            of where you live. If you are a consumer, your statutory rights stand whatever this
            section says.
          </p>
        </Clause>

        <Clause n="11" title="Termination">
          <p>
            You may stop using the service at any time, cancel your subscription from{" "}
            <em className="not-italic text-bone">Settings → Subscription</em>, and delete your
            account outright from{" "}
            <em className="not-italic text-bone">Settings → Account → Delete account</em>. Deleting
            the account cancels any subscription and removes the data described in the{" "}
            <Inline href="/privacy">privacy policy</Inline>.
          </p>
          <p>
            We may suspend or close an account that breaches section 8, that we are legally required
            to close, or that has gone unpaid after Stripe has finished trying to collect. Where the
            breach is one that can be fixed and the circumstances allow it, we will say what is
            wrong before closing anything.
          </p>
          <p>
            Closing your account does not stop the daemon on your machines. It is your software on
            your hardware, and it is yours to keep running, point at another server, or uninstall.
          </p>
        </Clause>

        <Clause n="12" title="Changes to these terms">
          <p>
            We may update these terms. If a change materially affects you, we will tell you by email
            or in the app before it takes effect, and for a subscriber it applies from the following
            renewal. Continuing to use the service after that is acceptance; if you would rather
            not, cancel before the renewal.
          </p>
        </Clause>

        <Clause n="13" title="Governing law and disputes">
          <p>
            These terms are governed by the law of <Pending>[GOVERNING LAW]</Pending>, and disputes
            go to the courts of <Pending>[JURISDICTION]</Pending>. If you are a consumer, this does
            not deprive you of the protection of the mandatory law of the country you live in, and
            you may bring proceedings there.
          </p>
          <p>
            Consumers in the EU may also use the European Commission's online dispute resolution
            platform. We would rather you wrote to us first, at <Pending>[CONTACT ADDRESS]</Pending>
            .
          </p>
        </Clause>

        <Clause n="14" title="Contact">
          <p>
            <Pending>[LEGAL ENTITY NAME]</Pending>, <Pending>[REGISTERED ADDRESS]</Pending>.
            Questions, notices, and withdrawals: <Pending>[CONTACT ADDRESS]</Pending>.
          </p>
        </Clause>
      </div>

      <Colophon billingEnabled={billingEnabled} />
    </main>
  );
}

/**
 * The Article 11a withdrawal function, given the prominence the rule asks for.
 * The label is fixed by law and is not ours to make flavourful.
 */
function WithdrawalFunction() {
  return (
    <div className="my-8 rounded-sm border border-line-strong bg-char p-6 sm:p-7">
      <p className="mb-4 font-sigil text-[11px] tracking-[0.22em] text-ember uppercase">
        Withdraw from contract
      </p>
      <p className="text-[16px] leading-7 text-ash">
        To exercise the right of withdrawal, send us an unambiguous statement that you are
        withdrawing — by email to <Pending>[CONTACT ADDRESS]</Pending>, quoting the email address on
        your account. It is enough that you send it before the 14 days are up.
      </p>
      <p className="mt-4 text-[15px] leading-7 text-ash">
        <Pending>
          [WITHDRAWAL FUNCTION — owner to confirm the address above and, if a form rather than an
          email is wanted, the route it posts to. Consumer Rights Directive Article 11a has been
          mandatory since 19 June 2026 and binds non-EU traders selling to EU consumers.]
        </Pending>
      </p>
    </div>
  );
}

/** Annex I(B) of the Consumer Rights Directive, verbatim in substance. */
function ModelForm() {
  return (
    <div className="my-8 border-line-strong border-l-2 pl-6">
      <p className="mb-4 font-sigil text-[11px] tracking-[0.22em] text-ash uppercase">
        Model withdrawal form
      </p>
      <div className="space-y-3 text-[15px] leading-7 text-ash">
        <p>
          To <Pending>[LEGAL ENTITY NAME]</Pending>, <Pending>[REGISTERED ADDRESS]</Pending>,{" "}
          <Pending>[CONTACT ADDRESS]</Pending>:
        </p>
        <p>
          I hereby give notice that I withdraw from my contract for the supply of the following
          service: SPAWN D subscription.
        </p>
        <p>Ordered on / received on: ……………</p>
        <p>Name of consumer: ……………</p>
        <p>Address of consumer: ……………</p>
        <p>Email address on the account: ……………</p>
        <p>Date: ……………</p>
      </div>
    </div>
  );
}

/* ── The page's own furniture ─────────────────────────────────── */

/**
 * A decision only the owner can make, printed as a visible gap. Never quietly
 * filled with something plausible: an invented company name or jurisdiction in
 * a contract is a lie that ships, where a bracket is a task that gets done.
 */
function Pending({ children }: { children: ReactNode }) {
  return (
    <span className="text-hellfire underline decoration-hellfire/50 decoration-dotted underline-offset-4">
      {children}
    </span>
  );
}

function DraftBanner() {
  return (
    <div className="border-line-g border-b bg-char px-5 py-6 sm:px-8">
      <p className="mx-auto w-full max-w-3xl text-[15px] leading-7 text-ash">
        <span className="font-sigil text-[11px] tracking-[0.22em] text-hellfire uppercase">
          Pre-launch draft ·{" "}
        </span>
        This page is not yet in force. Every <Pending>[bracketed item]</Pending> below needs the
        owner's decision before SPAWN D sells a subscription, and this banner comes down with the
        last of them.
      </p>
    </div>
  );
}

function Clause({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section className="border-line-g border-t py-10 first:border-t-0 first:pt-0">
      <div className="mb-4 flex items-baseline gap-4">
        <span className="font-sigil text-[12px] tracking-[0.22em] text-ember uppercase">{n}</span>
        <h2
          className={cn(
            poster.className,
            "text-[clamp(21px,2.6vw,28px)] leading-[1.12] font-light text-bone uppercase",
          )}
        >
          {title}
        </h2>
      </div>
      <div className="space-y-4 text-[16px] leading-7 text-ash">{children}</div>
    </section>
  );
}

function Inline({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="text-bone underline decoration-ember/70 underline-offset-4 transition-colors hover:text-ember"
    >
      {children}
    </Link>
  );
}
