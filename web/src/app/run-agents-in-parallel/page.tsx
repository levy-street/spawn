import type { Metadata } from "next";
import Link from "next/link";
import { FleetCapture } from "@/components/seo/templates/FleetCapture";
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

/*
 * The flagship job page, written for someone who has never heard of spawnd:
 * first the pattern they searched for, taught neutrally (worktrees + panes,
 * doable today in iTerm2 or tmux); then where that setup honestly runs out;
 * only then spawnd, as the substrate that holds the same pattern. Every
 * claim survives a diff against docs/TRUST.md and README.md.
 */

const TITLE = "Run multiple Claude Code sessions in parallel";
const DESCRIPTION =
  "The worktree-per-agent pattern for parallel Claude Code sessions — how to run it in the terminal you have, where it breaks, and how to keep the fleet alive when you walk away.";
const PATH = "/run-agents-in-parallel";

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
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

const FAQ = [
  {
    q: "Can’t I just split panes in iTerm2 or tmux?",
    a: "Yes — that’s the pattern above, and at one machine with the lid open it’s enough. spawnd is for the rest of the time: machines plural, laptop closed, a prompt answered from wherever you are. The workflow doesn’t change; the substrate does.",
  },
  {
    q: "How do parallel Claude Code sessions stay out of each other’s way?",
    a: "Give each one its own directory — one git worktree per session is the clean version. A session starts your login shell in the directory you choose, so the isolation is the filesystem’s, not a sandbox’s. Each CLI authenticates itself on the host; spawnd never holds your provider keys.",
  },
  {
    q: "Do I still need tmux underneath?",
    a: "No. Persistence is structural: each session’s PTY is owned by a worker process on the host, so it survives the closed tab, the dropped connection, even a restart of the daemon itself — scrollback intact. If you like tmux as a layout tool it runs fine inside a tile; it just stops being load-bearing.",
  },
  {
    q: "Can sessions in one grid live on different machines?",
    a: "Yes. A workspace names its sessions, not a host: the dev box, the GPU rig, and a VPS can sit in adjacent tiles. Each tile’s terminal traffic is end-to-end encrypted from your browser to that tile’s own daemon — the server introduces the endpoints and carries signaling, nothing more.",
  },
  {
    q: "What happens when an agent asks for permission while I’m out?",
    a: "The session raises agent.awaiting_input: the tile and the sidebar mark it, and alerts can reach your phone as system notifications. Open the grid from any device you’ve approved and answer — it’s the same live terminal, so a yes is one keystroke.",
  },
  {
    q: "Is spawnd managing the agent processes?",
    a: "No, deliberately. An agent button types a visible command — claude, codex, opencode, aider — into a real shell. There’s no wrapper to crash and no hidden flags, so there’s nothing between you and the CLI. Kill one, rerun one, pipe one through tee: it’s your shell.",
  },
];

const RELATED = [
  {
    title: "Keep agents running",
    blurb: "what happens to the fleet when the laptop closes",
    href: "/use/keep-agents-running",
  },
  {
    title: "AI agents on your own GPU",
    blurb: "the rig as a first-class host in the grid",
    href: "/use/ai-agents-on-your-own-gpu",
  },
  {
    title: "Claude Code",
    blurb: "the pillar page for the CLI itself",
    href: "/for/claude-code",
  },
  {
    title: "Claude Code on your phone",
    blurb: "the device that answers the permission prompt",
    href: "/use/claude-code-on-your-phone",
  },
];

export default function RunAgentsInParallelPage() {
  return (
    <JobPage
      crumbs={[{ name: "Use cases", href: "/use" }]}
      pageName="Run agents in parallel"
      canonicalPath={PATH}
      hero={{
        title: { plain: "Run multiple Claude\u00A0Code sessions", accent: "in parallel" },
        sub: "How to run a fleet of coding agents side by side — the worktree pattern, the terminal setup, and what it takes to keep the fleet alive after you stand up.",
        date: "spawnd · August 2026",
        ink: { video: "/brand/ink/grid-ink.mp4", poster: "/brand/ink/grid-ink.png" },
      }}
      faq={FAQ}
      related={RELATED}
    >
      <JobSection className="pt-20 sm:pt-28">
        <JobProse>
          <JobH2>One agent per worktree. One worktree per pane.</JobH2>
          <div className="mt-8 space-y-5">
            <p>
              Claude&nbsp;Code runs one session per invocation, so parallelism is yours to arrange —
              and the arrangement that matters is on the filesystem. Two agents in one checkout will
              trip over the same index, the same build directory, and each other’s diffs. Git
              worktrees end it: one checkout per branch, every branch off one clone.
            </p>
            <p>
              Then give each worktree a terminal of its own. Split panes in iTerm2, tmux, or
              whatever you already drive; start <span className="text-bone">claude</span> in each
              lane.
            </p>
          </div>
          <div className="mt-10">
            <JobCodeFigure caption="The lanes, cut in three commands.">
              <p className="whitespace-nowrap">
                <span className="text-ash">$</span> git worktree add ../wt/auth -b agents/auth
              </p>
              <p className="whitespace-nowrap">
                <span className="text-ash">$</span> git worktree add ../wt/importer -b
                agents/importer
              </p>
              <p className="whitespace-nowrap">
                <span className="text-ash">$</span> git worktree add ../wt/perf -b agents/perf
              </p>
              <p className="whitespace-nowrap pt-2 text-ash"># one pane per lane, claude in each</p>
            </JobCodeFigure>
          </div>
          <p className="mt-10">
            That’s a working fleet — three agents, three lanes, one screen — and it needs nothing
            you don’t already have. At one machine, with the lid open, it’s genuinely enough.
          </p>
        </JobProse>
      </JobSection>

      <JobSection>
        <JobProse>
          <JobH2>The splits work until you stand up.</JobH2>
          <div className="mt-10">
            <JobPoints
              items={[
                {
                  title: "One screen",
                  body: "The panes live in one terminal app on one machine. The GPU box’s agents need an SSH session and a second set of splits; a third machine, a third. The fleet has no single place to be.",
                },
                {
                  title: "Mortal sessions",
                  body: "Close the laptop and every pane dies mid-edit. tmux keeps the shells alive — if you remembered to start every lane inside it, on every machine, every time.",
                },
                {
                  title: "Silent prompts",
                  body: "An agent waiting for permission in pane four doesn’t tell you. A fleet you have to poll is a serial job with more windows — the ceiling isn’t compute, it’s how long a question waits.",
                },
              ]}
            />
          </div>
        </JobProse>
      </JobSection>

      <JobSection>
        <JobProse>
          <JobH2>The same pattern, held by infrastructure.</JobH2>
          <p className="mt-8">
            spawnd keeps the workflow — worktrees, one real login shell per agent — and replaces
            what carries it. A small daemon on each of your machines owns the sessions; your browser
            holds them as one grid.
          </p>
        </JobProse>
        <div className="mx-auto mt-12 w-full max-w-5xl sm:mt-14">
          <FleetCapture caption="A workspace: six sessions across three machines." />
        </div>
        <JobProse className="mt-12 sm:mt-16">
          <JobPoints
            items={[
              {
                title: "Every machine, one grid",
                body: "Tiles on the dev box sit beside tiles on the rig and a five-dollar VPS — no SSH juggling, no second set of splits. The daemons dial out, and the grid is the single place the fleet lives.",
              },
              {
                title: "Close the lid; nothing dies",
                body: "Sessions are owned by worker processes on the host, not by your terminal app. They survive closed tabs, dropped wifi, even a restart of the daemon itself — scrollback intact.",
              },
              {
                title: "The prompt finds you",
                body: "A session that needs an answer marks its tile, and the alert can reach your phone. Any approved device opens the same live terminal — a yes is one keystroke.",
              },
            ]}
          />
        </JobProse>
      </JobSection>

      <JobSection className="py-8 sm:py-10">
        <JobProse>
          <p className="text-[15px] leading-7">
            Real PTYs owned by host workers. Hosts dial out — zero open ports. End-to-end encrypted
            past our own server. Open source, MIT / Apache-2.0.{" "}
            <Link href="/security" className={JOB_LINK}>
              Read the threat model
            </Link>
            .
          </p>
        </JobProse>
      </JobSection>

      <JobStart heading="One line on any host you own." />
    </JobPage>
  );
}
