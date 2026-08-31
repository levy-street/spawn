import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Colophon, Eyebrow, Masthead, RegistrationMarks } from "@/components/brand/press";
import { readBillingConfig } from "@/lib/billing-server";
import { poster } from "@/lib/fonts";
import { cn } from "@/lib/utils";

/*
 * Privacy policy.
 *
 * THIS PAGE IS THE SOURCE OF TRUTH FOR THE APP STORE PRIVACY NUTRITION LABEL
 * AND THE GOOGLE PLAY DATA SAFETY FORM. Every answer given in App Store Connect
 * or the Play Console must be findable here, and a change on either side is a
 * change on both. They drift the moment somebody edits one alone.
 *
 * It must also stay *accurate*, which is a stricter bar than "reassuring".
 * `docs/TRUST.md` keeps the honest inventory of what the server actually holds
 * and stakes a careful claim — the server *cannot* read protected content
 * (cryptographic), not merely *does not look* (policy). Do not widen that claim
 * here. The named exceptions (the foreground executable basename, the session
 * working directory, agent and skill definitions, historical transcripts not
 * yet purged from backups) are in this page precisely because they are true.
 *
 * `/terms` is the sibling of this page and the two must agree.
 */

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What the SPAWN D service holds about you, what it cannot see, who else it reaches, how long it is kept, and how to have all of it deleted — including without installing the app.",
};

export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
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
          <Eyebrow className="mb-5">Privacy policy</Eyebrow>
          <h1
            className={cn(
              poster.className,
              "mb-6 text-[clamp(32px,6vw,58px)] leading-[1.02] font-light text-bone uppercase [text-wrap:balance]",
            )}
          >
            The whole ledger. <em className="text-hellfire not-italic">Not the flattering half.</em>
          </h1>
          <p className="mx-auto max-w-[58ch] text-[17px] leading-8 text-ash">
            What the service holds, what it cannot see, who else it reaches, how long it is kept,
            and how to have every bit of it deleted. Where the honest answer is awkward, the awkward
            answer is the one printed.
          </p>
          <p className="mt-6 font-sigil text-[11px] tracking-[0.18em] text-ash uppercase">
            In force from <Pending>[EFFECTIVE DATE]</Pending>
          </p>
        </div>
      </header>

      <DraftBanner />

      <div className="mx-auto w-full max-w-3xl px-5 pt-16 pb-24 sm:px-8">
        <Clause n="1" title="Who this covers">
          <p>
            This policy covers the hosted SPAWN D service at spawnd.dev, operated by{" "}
            <Pending>[LEGAL ENTITY NAME]</Pending>, <Pending>[REGISTERED ADDRESS]</Pending>, and the
            browser, desktop and phone apps that sign in to it. For data protection purposes we are
            the controller of the data described below. Reach us at{" "}
            <Pending>[CONTACT ADDRESS]</Pending>.
          </p>
          <p>
            It does not cover an install you host yourself. If you run the server on your own
            machines, that deployment holds your data and we never see it — no account of yours
            exists with us, and nothing on this page applies. Self-hosting is the deliberate answer
            for anyone the inventory below bothers, and it is{" "}
            <Inline href="/download">free and unlimited</Inline>.
          </p>
        </Clause>

        <Clause n="2" title="What the service cannot see">
          <p>
            Terminal input, output and scrollback travel end to end encrypted between the browser or
            phone you are signed in on and the daemon on your host. The keys live at those two
            endpoints. Our servers hold none of them, so the claim we make is the strong one:{" "}
            <em className="not-italic text-bone">
              the service cannot read your terminal, rather than does not look
            </em>
            . When your network forces traffic through a relay, the relay forwards ciphertext it
            cannot decrypt.
          </p>
          <p>
            The same is true of the contents of files on your hosts, the previews the file browser
            renders, and what your agents actually say or do. There is no server code path that
            carries any of it and no store it could land in.
          </p>
          <p>
            This does not extend to a compromised endpoint. Anyone who controls your host or a
            device you have approved sees what that endpoint sees, and no cryptography on our side
            changes that.
          </p>
        </Clause>

        <Clause n="3" title="What the service does hold">
          <p>The honest inventory, in the categories the server actually stores:</p>
          <ul className="mt-4 space-y-3 pl-5 text-[16px] leading-7 text-ash [&>li]:list-disc">
            <li>
              <Term>Account.</Term> Your email address, a hash of your password (never the
              password), when the account was created, whether the address is verified, and — if you
              signed in with Google, Microsoft, GitHub or Apple — the identifier that provider gives
              us for you.
            </li>
            <li>
              <Term>Hosts.</Term> The name you give each host, its operating system, architecture,
              daemon version and when it was last seen; its static hardware specification; and a
              coarse five-level reading of processor and memory load refreshed as it reports in,
              plus a daily activity rollup. The load reading is bucketed on the host on purpose: a
              precise utilisation trace of your machines is a behavioural fingerprint, so the server
              is only ever given the blunt version.
            </li>
            <li>
              <Term>Workspaces and sessions.</Term> Workspace names, positions and layouts; session
              names, which host they belong to, their working directory, lifecycle state, exit codes
              and activity timestamps.
            </li>
            <li>
              <Term>The foreground program name.</Term> A knowing exception to the rule above, and
              stated rather than buried: for each session the daemon reports the bare filename of
              the program currently in the foreground —{" "}
              <code className="font-sigil text-[15px] text-ember">claude</code>,{" "}
              <code className="font-sigil text-[15px] text-ember">vim</code> — truncated, and never
              its arguments, paths, environment or output. It exists so pane headers can say what is
              running. The server therefore learns which programs you run and when that changes. If
              program names are themselves sensitive to you, self-host.
            </li>
            <li>
              <Term>Agents and skills.</Term> Agent definition names, kinds, commands, environment
              prefixes and install commands; skill names, descriptions and bodies; which agents you
              have allowed to start without a prompt. These are configuration you write, and the
              server stores them.
            </li>
            <li>
              <Term>Trust material.</Term> The public keys of your devices and hosts, and the
              records of approvals and revocations between them. Public keys only — the private
              halves never leave the device that made them.
            </li>
            <li>
              <Term>Connection metadata.</Term> IP addresses, connection and signalling timing, and
              approximate volume. Who talked to which host and when is necessarily visible to a
              service whose whole job is introducing them, and we do not claim otherwise.
            </li>
            <li>
              <Term>Notifications.</Term> If you turn on push notifications, the push token your
              phone or browser issues, the platform it is on and when it was last seen. Alert
              payloads carry a session id, an event class, the foreground program name and an exit
              code — never terminal text.
            </li>
          </ul>
          <p>
            The engineering record of all of this, including the parts we would rather were
            different, is kept in the project's trust document alongside the{" "}
            <Inline href="/security">security page</Inline>.
          </p>
        </Clause>

        <Clause n="4" title="Billing data">
          <p>
            If you buy a subscription, the service additionally holds: the customer and subscription
            identifiers Stripe issues for you, which plan you are on, the subscription's status,
            when the current period ends, and whether it is set to stop at that point.
          </p>
          <p>
            <em className="not-italic text-bone">We never hold your card.</em> Card numbers,
            expiries and security codes are entered on Stripe's own checkout and never reach our
            servers. Stripe processes payments as our processor and as its own controller for fraud,
            tax and financial-record purposes; its handling is described in Stripe's privacy policy.
          </p>
          <p>
            On a self-hosted install none of this exists. Billing is off, the billing routes are not
            registered, and there is no customer record, plan or renewal date to store.
          </p>
        </Clause>

        <Clause n="5" title="Email">
          <p>
            We use your address to run the account: verification, password resets, device-approval
            notices, and — for subscribers — messages about the plan, the host limit and payment
            problems. Receipts come from Stripe. We do not send marketing email and there is no list
            to be on.
          </p>
        </Clause>

        <Clause n="6" title="Cookies, and what the browser keeps">
          <p>
            The site sets one cookie,{" "}
            <code className="font-sigil text-[15px] text-ember">spawn_session</code>, which holds
            your signed-in session. It is HTTP-only, so page scripts cannot read it, and it exists
            to keep you signed in. There are no advertising cookies and no tracking cookies, because
            there is no advertising and no tracking.
          </p>
          <p>
            The apps also keep things in your own browser or device storage — your device's identity
            key, your theme, your layout, which build you last downloaded. That stays on your
            device.
          </p>
          <p>
            There are no third-party analytics on this site or in the apps. No Google Analytics, no
            product analytics, no session recording, no advertising SDK. We do not sell or share
            personal data, and there is nothing here that would let us.
          </p>
        </Clause>

        <Clause n="7" title="Who else it reaches">
          <p>Beyond us, the service depends on:</p>
          <ul className="mt-4 space-y-2.5 pl-5 text-[16px] leading-7 text-ash [&>li]:list-disc">
            <li>
              <Term>Stripe</Term> — payments and subscription records, for subscribers only.
            </li>
            <li>
              <Term>Our hosting and network providers</Term> — the servers the service runs on, in{" "}
              <Pending>[HOSTING REGION]</Pending>.
            </li>
            <li>
              <Term>Our email provider</Term> — delivery of the account email described above.
            </li>
            <li>
              <Term>Apple and Google's push services</Term> — delivery of a notification to your
              device, if you turned notifications on.
            </li>
          </ul>
          <p>
            We may also disclose data where the law requires it. We would rather have as little as
            possible to hand over, which is the reason the architecture is shaped the way it is.
          </p>
          <p>
            Where data moves between countries, we rely on{" "}
            <Pending>[TRANSFER MECHANISM — owner to confirm]</Pending>.
          </p>
        </Clause>

        <Clause n="8" title="Why we are allowed to hold it">
          <p>
            For people in the UK and the EU: account, host, session and billing data are processed
            because they are necessary to perform the contract in the{" "}
            <Inline href="/terms">terms of service</Inline>. Connection metadata and security logs
            are processed under our legitimate interest in keeping the service running and secure.
            Push notifications rely on the permission you gave your device. Where we ask for
            consent, you can withdraw it.
          </p>
        </Clause>

        <Clause n="9" title="How long it is kept">
          <p>
            Account, host, workspace, session, agent and skill records are kept for as long as the
            account exists, and go when it does. Server and connection logs are kept for{" "}
            <Pending>[LOG RETENTION WINDOW — owner to set]</Pending>. Billing records are kept for
            as long as tax and accounting law requires, which outlives the account.
          </p>
          <p>
            One honest wrinkle. Earlier versions of the server stored terminal transcripts on its
            own disks. That code has been removed and no transcript is written today, but historical
            copies may still exist in backups until the purge that removes them has finished. It is
            tracked, it is not done, and it would be dishonest to imply otherwise.
          </p>
        </Clause>

        <Clause n="10" title="Your rights">
          <p>
            You can ask for a copy of your data, ask us to correct it, ask us to delete it, object
            to processing based on legitimate interests, or ask for it in a portable form. Write to{" "}
            <Pending>[CONTACT ADDRESS]</Pending> and we will answer within the time the law allows.
            If you are in the UK or the EU and think we have got it wrong, you can complain to your
            data protection authority.
          </p>
        </Clause>

        <Clause n="11" title="Deleting your account, from inside the app">
          <p>
            Open <em className="not-italic text-bone">Settings → Account → Delete account</em>. You
            will be asked to retype the email address on the account, and to give your password if
            the account has one. That is the app's front end for{" "}
            <code className="font-sigil text-[15px] text-ember">POST /api/auth/account/delete</code>
            .
          </p>
          <p>
            The deletion is permanent and immediate. It cancels any subscription first, releases the
            identity keys claimed by your hosts, closes the live daemon connections, and removes the
            account and everything that hangs off it — hosts, workspaces, sessions, agents, skills,
            device records, push tokens. Billing records Stripe must keep for tax purposes survive,
            and backups age out on their own schedule.
          </p>
          <p>
            The daemon on your machines keeps running until you stop it. It is your software on your
            hardware; deleting the account does not uninstall it.
          </p>
        </Clause>

        <section id="delete-request" className="scroll-mt-24">
          <Clause n="12" title="Requesting deletion without the app">
            <p>
              You do not have to install anything, or still have access to the app, to have your
              account deleted. This section is that route, and it is deliberately reachable from the
              open web.
            </p>
            <div className="my-6 rounded-sm border border-line-strong bg-char p-6 sm:p-7">
              <p className="mb-4 font-sigil text-[11px] tracking-[0.22em] text-ember uppercase">
                Request account deletion
              </p>
              <p className="text-[16px] leading-7 text-ash">
                Email <Pending>[CONTACT ADDRESS]</Pending> from the address on the account, with the
                subject <em className="not-italic text-bone">Delete my account</em>. We will confirm
                the request, delete the account and everything listed in section 11, and write back
                when it is done — within 30 days, and usually far sooner.
              </p>
              <p className="mt-4 text-[15px] leading-7 text-ash">
                If you cannot write from that address, say so and tell us how else you can prove the
                account is yours. We will not delete an account on the word of someone who cannot
                show it is theirs — that would be its own privacy failure.
              </p>
            </div>
            <p className="text-[15px]">
              What is deleted, what is kept, and for how long, are exactly as set out in section 11
              and section 9. This route and the in-app one do the same thing.
            </p>
          </Clause>
        </section>

        <Clause n="13" title="Children">
          <p>
            The service is not for children. We do not knowingly collect data from anyone under the
            age at which they could agree to it where they live, and we delete such an account if we
            learn of one.
          </p>
        </Clause>

        <Clause n="14" title="Changes to this policy">
          <p>
            We will update this page when what we hold changes, and tell you by email or in the app
            when a change is material. The date at the top is when the current version took effect.
          </p>
        </Clause>

        <Clause n="15" title="Contact">
          <p>
            <Pending>[LEGAL ENTITY NAME]</Pending>, <Pending>[REGISTERED ADDRESS]</Pending>. Privacy
            questions, access requests and deletion requests: <Pending>[CONTACT ADDRESS]</Pending>.
          </p>
        </Clause>
      </div>

      <Colophon billingEnabled={billingEnabled} />
    </main>
  );
}

/* ── The page's own furniture ─────────────────────────────────── */

/**
 * A decision only the owner can make, printed as a visible gap rather than
 * quietly filled with something plausible. In a privacy policy an invented
 * answer is not a placeholder, it is a misstatement to a regulator.
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
        The inventory below is accurate; the <Pending>[bracketed items]</Pending> are the owner's to
        fill in before this page goes live, and the App Store and Play Store answers must be written
        from the finished version.
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

function Term({ children }: { children: ReactNode }) {
  return <span className="text-bone">{children}</span>;
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
