import type { Metadata, Viewport } from "next";
import Link from "next/link";
import {
  JOB_LINK,
  JobCodeFigure,
  JobH2,
  JobPage,
  JobPoints,
  JobProse,
  JobSection,
  JobStart,
} from "@/components/seo/templates/JobPage";
import { Calculator } from "./Calculator";

/*
 * A tool page on the job frame: the plans taught first, from Anthropic's own
 * pages (every figure is sourced in Calculator.tsx), then the calculator as
 * one client island, then the honest arithmetic on extra usage, and only
 * then the product — one subscription, every host you own.
 */

const TITLE = "Claude plan calculator: Pro vs Max 5x vs Max 20x vs API";
const DESCRIPTION =
  "Estimate your monthly Claude Code tokens, what they would cost at API list prices, and whether Pro, Max 5x, or Max 20x plausibly covers it — assumptions shown.";
const PATH = "/claude-plan-calculator";
const OG_IMAGE = "/og/claude-plan-calculator.jpg";
// Kept honest: when the page shipped, and when its content last changed.
const DATE_PUBLISHED = "2026-09-03";
const DATE_MODIFIED = "2026-09-03";

// Marketing pages let readers zoom; the app's locked viewport stays app-side.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: "#000000",
};

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: PATH,
    siteName: "spawnd",
    type: "article",
    publishedTime: DATE_PUBLISHED,
    modifiedTime: DATE_MODIFIED,
    images: [{ url: OG_IMAGE, width: 2400, height: 1260, alt: TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
};

const FAQ = [
  {
    q: "Does Claude Code on Pro use Opus?",
    a: "Pro starts Claude Code on Sonnet 5; Max starts it on Opus 5. Run /model to see what your account offers and switch. Opus costs two and a half times as much per token at API rates, and it draws a session down at about that rate too.",
  },
  {
    q: "Do the limits reset monthly?",
    a: "No. There is a session limit that resets every five hours and a weekly limit that resets at a fixed time each week, plus per-model weekly caps. The calculator averages to a month so the numbers can sit next to the prices; a bursty week reaches the cap sooner than the average suggests.",
  },
  {
    q: "Is the API cheaper than a Max plan?",
    a: "For light or occasional use, often yes — the calculator prints the list-price cost next to every plan and flags when it undercuts the plan you would need. Past a couple of hours a day the plans win, and Max 20x is the best value per dollar of the three.",
  },
];

const RELATED = [
  {
    title: "Claude Code",
    blurb: "the pillar page for the CLI itself",
    href: "/for/claude-code",
  },
  {
    title: "Claude Code on the Max plan",
    blurb: "what the plan actually gets you in the terminal",
    href: "/claude-code-max-plan",
  },
  {
    title: "Run agents in parallel",
    blurb: "several sessions, several machines, one pool of usage",
    href: "/run-agents-in-parallel",
  },
];

export default function ClaudePlanCalculatorPage() {
  return (
    <JobPage
      crumbs={[{ name: "Guides", href: "/guides" }]}
      pageName="Claude plan calculator"
      canonicalPath={PATH}
      hero={{
        title: { plain: "Claude plan calculator:", accent: "Pro vs Max vs API" },
        sub: "Put in how much your agents actually run and get back the tokens, the list-price cost, and which plan plausibly covers it — with every assumption on the table.",
        date: "spawnd · September 2026",
        ink: { video: "/brand/ink/hero-ink.mp4", still: "/brand/ink/hero-ink-still.webp" },
      }}
      faq={FAQ}
      related={RELATED}
      article={{
        headline: TITLE,
        description: DESCRIPTION,
        image: OG_IMAGE,
        datePublished: DATE_PUBLISHED,
        dateModified: DATE_MODIFIED,
      }}
    >
      <JobSection refId="s1" className="pt-20 sm:pt-28">
        <JobProse>
          <JobH2>Three plans, one pool of usage.</JobH2>
          <div className="mt-8 space-y-5">
            <p>
              <Link
                prefetch={false}
                href="https://claude.com/pricing"
                className={JOB_LINK}
                target="_blank"
                rel="noreferrer"
              >
                Claude Pro
              </Link>{" "}
              is $20 a month ($17 on annual billing). Max comes in two sizes:{" "}
              <Link
                prefetch={false}
                href="https://support.claude.com/en/articles/11049741-what-is-the-max-plan"
                className={JOB_LINK}
                target="_blank"
                rel="noreferrer"
              >
                Max 5x at $100 a month and Max 20x at $200
              </Link>
              . Anthropic defines the multiplier per session: Max 5x gives five times more usage per
              session than Pro, Max 20x twenty times. That is the whole published quota — a ratio,
              not a token count.
            </p>
            <p>
              A session is a five-hour window. On top of the session limit, every paid plan has a{" "}
              <Link
                prefetch={false}
                href="https://support.claude.com/en/articles/8325606-what-is-the-pro-plan"
                className={JOB_LINK}
                target="_blank"
                rel="noreferrer"
              >
                weekly limit that applies across all models
              </Link>
              , resetting at a fixed time each week assigned to your account, and Claude Code
              reports separate weekly caps per model family. Everything you do in the Claude apps
              and in Claude Code{" "}
              <Link
                prefetch={false}
                href="https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan"
                className={JOB_LINK}
                target="_blank"
                rel="noreferrer"
              >
                draws on the same limits
              </Link>
              .
            </p>
            <p>
              Claude Code is included on all three. What differs is the{" "}
              <Link
                prefetch={false}
                href="https://code.claude.com/docs/en/model-config"
                className={JOB_LINK}
                target="_blank"
                rel="noreferrer"
              >
                default model
              </Link>
              : on Pro it starts on Sonnet 5, on Max on Opus 5, and <code>/model</code> switches
              either way. At{" "}
              <Link
                prefetch={false}
                href="https://platform.claude.com/docs/en/about-claude/pricing"
                className={JOB_LINK}
                target="_blank"
                rel="noreferrer"
              >
                API list prices
              </Link>{" "}
              Opus 5 costs two and a half times Sonnet 5 per token — $5 in and $25 out per million
              against $2 and $10 — which is the main reason Max subscribers burn through a session
              faster than the multiplier led them to expect.
            </p>
            <p>
              When the pool runs dry you can wait for the reset, or turn on{" "}
              <Link
                prefetch={false}
                href="https://support.claude.com/en/articles/12429409-manage-extra-usage-for-paid-claude-plans"
                className={JOB_LINK}
                target="_blank"
                rel="noreferrer"
              >
                usage credits
              </Link>
              : prepaid funds billed at standard API rates, under a monthly spend limit you set.{" "}
              <Link
                prefetch={false}
                href="https://support.claude.com/en/articles/14246112-buy-usage-bundles"
                className={JOB_LINK}
                target="_blank"
                rel="noreferrer"
              >
                Bundles
              </Link>{" "}
              of $50, $250, and $1,000 take 10, 20, and 30 percent off those rates.
            </p>
          </div>
        </JobProse>
      </JobSection>

      <JobSection refId="s2" className="pt-0 sm:pt-0">
        <JobProse>
          <JobH2>The calculator.</JobH2>
          <p className="mt-6 max-w-[58ch]">
            Nothing is stored and nothing is sent; the sums run in your browser. Every number that
            is not Anthropic’s is editable under “Assumptions”.
          </p>
        </JobProse>
        <div className="mt-10">
          <Calculator />
        </div>
      </JobSection>

      <JobSection refId="s3">
        <JobProse>
          <JobH2>How Claude Code spends a plan.</JobH2>
          <div className="mt-8 space-y-5">
            <p>
              Every turn sends the conversation so far, the project context, and the new prompt, and
              an agentic turn is many requests — one per tool call round. That is why the calculator
              counts context traffic per active hour rather than what you typed: a one-line question
              in a session that has been open all day still carries the whole day. Prompt caching
              makes the re-sent part cheap — a cache read is a tenth of the input price — and on a
              subscription the cache{" "}
              <Link
                prefetch={false}
                href="https://code.claude.com/docs/en/costs"
                className={JOB_LINK}
                target="_blank"
                rel="noreferrer"
              >
                lives an hour
              </Link>
              , dropping to five minutes once you are drawing on usage credits.
            </p>
            <p>
              The cheapest habits follow from that. <code>/clear</code> between unrelated tasks, so
              the next request does not carry the last one. Sonnet for the routine work and Opus
              where the reasoning earns its price. Fewer MCP servers in context. And the check
              itself, from inside the CLI:
            </p>
          </div>
          <div className="mt-10">
            <JobCodeFigure
              refId="a1"
              caption="Inside Claude Code. /usage shows the plan bars and the session’s token stats; /cost is its alias."
            >
              <p className="whitespace-nowrap">
                <span className="text-ash">&gt;</span> /usage
              </p>
              <p className="whitespace-nowrap">
                <span className="text-ash">&gt;</span> /model
              </p>
              <p className="whitespace-nowrap">
                <span className="text-ash">&gt;</span> /usage-credits
              </p>
              <p className="whitespace-nowrap pt-2 text-ash">
                # plan bars, attribution, and a 24h / 7d breakdown; the model picker; credits on
                claude.ai
              </p>
            </JobCodeFigure>
          </div>
          <p className="mt-10">
            The errors are literal.{" "}
            <Link
              prefetch={false}
              href="https://code.claude.com/docs/en/errors"
              className={JOB_LINK}
              target="_blank"
              rel="noreferrer"
            >
              <code>You’ve hit your session limit</code>
            </Link>{" "}
            is the five-hour window; <code>You’ve hit your weekly limit</code> is the account-wide
            cap; <code>You’ve hit your Opus limit</code> is a per-model weekly cap, and switching to
            Sonnet with <code>/model</code> keeps you working.
          </p>
        </JobProse>
      </JobSection>

      <JobSection refId="s4">
        <JobProse>
          <JobH2>Is extra usage worth it, or the next plan up?</JobH2>
          <div className="mt-8 space-y-5">
            <p>
              The arithmetic is short. Max 20x gives twenty times Pro’s usage for ten times the
              price — twice the usage per dollar of Pro or Max 5x. So for anyone at the top of Max
              5x the answer is nearly always the upgrade: $100 more buys four times the pool, while
              $100 of credits buys $100 of tokens at list, or up to about $143 worth with the
              30-percent bundle. The calculator does this comparison for you, with the overflow it
              estimates against the step up.
            </p>
            <p>Credits earn their place in three cases.</p>
          </div>
          <div className="mt-10">
            <JobPoints
              items={[
                {
                  title: "You are already on Max 20x",
                  body: "There is no next plan. The weekly cap is the ceiling, and credits at API rates — cheaper by the bundle — are how the rest of the month gets paid for.",
                },
                {
                  title: "The spikes are rare",
                  body: "A release week that runs three agents overnight is not a reason to pay $100 more every month. Turn credits on with a spend limit that matches the spike.",
                },
                {
                  title: "You want the bill to be legible",
                  body: "Credits show up as dollars in /usage and on the usage page; the plan’s own pool does not. Some people want the meter even when the plan would have covered it.",
                },
              ]}
            />
          </div>
          <p className="mt-10">
            One thing the calculator cannot see is concurrency. Three sessions on three machines
            draw down the same five-hour window at three times the rate, so the weekly cap arrives
            on a Wednesday. If that is your shape, count all of the hours above, and weight the
            answer toward the bigger plan.
          </p>
        </JobProse>
      </JobSection>

      <JobSection refId="s5">
        <JobProse>
          <JobH2>Whichever plan you pick, the CLI logs in on the host.</JobH2>
          <div className="mt-8 space-y-5">
            <p>
              The subscription is attached to your account, and Claude Code authenticates on
              whatever machine it runs — the desk box, the GPU rig, the VPS — each one a{" "}
              <code>claude login</code> away from the same pool. Nothing about that changes with
              spawnd. Agents authenticate on the host, as always; spawnd holds no provider
              credentials and adds no API-key markup, so a Pro or Max plan is used exactly as
              Anthropic’s CLI uses it.
            </p>
            <p>
              What changes is where you can be. One daemon per host you own dials out, so nothing
              listens on the host and no VPN is needed; any browser is the console, and on a phone
              it installs to the home screen as a web app. The sessions live on the host — a worker
              process owns each PTY — so the run you started at the desk keeps going after the tab
              closes, and the permission prompt an agent raises at nine reaches your phone. Every
              machine you own shares the one subscription, from any device you have approved.{" "}
              <Link prefetch={false} href="/run-agents-in-parallel" className={JOB_LINK}>
                Running several agents at once
              </Link>{" "}
              is where that starts to matter; the{" "}
              <Link prefetch={false} href="/for/claude-code" className={JOB_LINK}>
                Claude Code page
              </Link>{" "}
              has the rest.
            </p>
          </div>
        </JobProse>
      </JobSection>

      <JobSection refId="s6" className="py-8 sm:py-10">
        <JobProse>
          <p className="text-[15px] leading-7">
            Real PTYs owned by host workers. Hosts dial out — zero open ports. Your browser talks to
            each daemon peer-to-peer, end-to-end encrypted. Open source, MIT / Apache-2.0.{" "}
            <Link prefetch={false} href="/security" className={JOB_LINK}>
              Read the threat model
            </Link>
            .
          </p>
        </JobProse>
      </JobSection>

      <JobStart heading="One subscription, every host you own." />
    </JobPage>
  );
}
