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
  JobShot,
  JobSplit,
  JobStart,
} from "@/components/seo/templates/JobPage";

/*
 * The flagship job page, written for someone who has never heard of spawnd:
 * first the pattern they searched for, taught neutrally (worktrees + panes,
 * doable today in iTerm2 or tmux); then where that setup honestly runs out;
 * then spawnd, feature by feature, each claim carried by a capture of the
 * real app. Every claim survives a diff against docs/TRUST.md and README.md.
 */

const TITLE = "Run multiple Claude Code sessions in parallel";
const DESCRIPTION =
  "How to run several Claude Code sessions at once — the worktree-and-panes setup, where it breaks, and how to manage the whole fleet from one place.";
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
    q: "Can each project have its own workspace?",
    a: "That’s the intended shape: a workspace per project, each a grid of that project’s sessions, all listed in the sidebar. Switching is a click, and the sessions in the workspace you left keep running exactly as they were.",
  },
  {
    q: "Which agents are supported?",
    a: "Claude Code, Codex, OpenCode, and Aider ship as built-in shortcuts, and any CLI can be added — an agent definition is just a named command. The shortcut types it into a real shell, so there’s nothing an agent needs to integrate with.",
  },
  {
    q: "How do parallel Claude Code sessions stay out of each other’s way?",
    a: "By default they just do — each session is its own process in whatever directory you start it, so separate projects are naturally separate. For several sessions inside one repo, give each a git worktree. Either way the isolation is the filesystem’s, and each CLI authenticates itself on the host; spawnd never holds your provider keys.",
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
        title: { plain: "Run multiple Claude Code sessions", accent: "in parallel" },
        sub: "How to run several coding agents at once — the setup that gets you there, and the management problem that shows up right after.",
        date: "spawnd · August 2026",
        ink: { video: "/brand/ink/grid-ink.mp4", poster: "/brand/ink/grid-ink.png" },
      }}
      faq={FAQ}
      related={RELATED}
    >
      <JobSection className="pt-20 sm:pt-28">
        <JobProse>
          <JobH2>Starting several sessions is easy. Managing them is the job.</JobH2>
          <div className="mt-8 space-y-5">
            <p>
              Claude&nbsp;Code sessions are fully independent, so parallel is just more invocations.
              Run one in the API repo, one in the side project, one in the client’s codebase — a
              pane per session in iTerm2, tmux, or whatever you already drive, and you’re parallel.
              (Several sessions inside one repo? A git worktree per branch keeps them out of each
              other’s way.)
            </p>
          </div>
          <div className="mt-10">
            <JobCodeFigure caption="Three projects, three sessions.">
              <p className="whitespace-nowrap">
                <span className="text-ash">$</span> cd ~/work/api && claude
              </p>
              <p className="whitespace-nowrap">
                <span className="text-ash">$</span> cd ~/side/game && claude
              </p>
              <p className="whitespace-nowrap">
                <span className="text-ash">$</span> cd ~/oss/spawn && claude
              </p>
              <p className="whitespace-nowrap pt-2 text-ash">
                # each in its own pane — nothing shared, nothing to coordinate
              </p>
            </JobCodeFigure>
          </div>
          <p className="mt-10">
            What you’ve really built, though, is a second job: window manager for a small team of
            agents. The work of parallel work isn’t writing code — it’s dispatching a task, noticing
            the pane that stopped, answering it, and remembering which session was doing what for
            which project. At one machine, with the lid open, that loop is manageable — and it needs
            nothing you don’t already have.
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
                  body: "The panes live in one terminal app on one machine. The GPU box’s agents need an SSH session and a second set of splits; a third machine, a third. There is no roster — no one place that knows what’s running where.",
                },
                {
                  title: "Mortal sessions",
                  body: "Close the laptop and every pane dies mid-edit. tmux keeps the shells alive — if you remembered to start every session inside it, on every machine, every time.",
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
          <JobH2>Keep the workflow. Hand off the managing.</JobH2>
          <p className="mt-8 max-w-[58ch]">
            spawnd doesn’t change how the agents work — each still gets a real login shell in its
            own directory. It changes how you run them. A small daemon on each of your machines owns
            the sessions; your browser holds the whole fleet as workspaces in one app — a control
            room instead of a pile of windows.
          </p>
        </JobProse>
        <div className="mx-auto mt-12 w-full max-w-5xl sm:mt-14">
          <FleetCapture caption="A workspace per project — switching is a click, and nothing stops." />
        </div>
      </JobSection>

      <JobSection>
        <JobSplit
          media={
            <JobShot
              src="/product/features/roster-sidebar.png"
              width={660}
              height={2040}
              alt="The spawnd sidebar: workspaces with attention badges above the Legion host list with live CPU and memory gauges"
              caption="The sidebar: workspaces above, machines below."
              className="mx-auto max-w-[300px]"
            />
          }
          flip
        >
          <JobH2>A workspace per project. A sidebar that knows everything.</JobH2>
          <div className="mt-6 space-y-5">
            <p>
              Each project gets a workspace — a named grid of that project’s sessions. The sidebar
              lists them all, and under them the Legion: every machine you’ve possessed, with live
              CPU and memory and a count of what’s running where.
            </p>
            <p>
              That list is the roster the pile of windows never had. Switching projects is one
              click; the workspace you leave keeps working, and the one you land in is already live
              — no reattach, no reconnect, no remembering.
            </p>
          </div>
        </JobSplit>
      </JobSection>

      <JobSection>
        <JobSplit
          media={
            <JobShot
              src="/product/features/attention.png"
              width={1930}
              height={1320}
              alt="A Claude Code session holding a permission prompt: the tile is marked and the workspace row carries an amber badge"
              caption="agent.awaiting_input: the tile, the tab, and the workspace row all mark it."
            />
          }
        >
          <JobH2>The one that needs you is marked.</JobH2>
          <div className="mt-6 space-y-5">
            <p>
              A session waiting on an answer raises an event, and the app wears it: the tile is
              marked, the tab counts it, the workspace row carries the badge. You stop polling
              panes; the grid tells you where to look.
            </p>
            <p>
              The alert can go further — system notifications can reach your phone, so the
              permission prompt raised at a quarter past nine doesn’t wait until morning.
            </p>
          </div>
        </JobSplit>
      </JobSection>

      <JobSection>
        <JobSplit
          media={
            <JobShot
              src="/product/features/phone.png"
              width={1170}
              height={2532}
              alt="The same workspace on a phone: the Claude Code permission prompt with the mobile terminal key bar"
              caption="The same live session, on the phone that happened to be in reach."
              className="mx-auto max-w-[300px]"
            />
          }
          flip
        >
          <JobH2>Any device you’ve approved is the console.</JobH2>
          <div className="mt-6 space-y-5">
            <p>
              The grid isn’t bound to the desk. Open the same workspace from a phone and it’s the
              same live terminal, mid-scrollback, with a key bar for the parts phones are bad at —
              Esc, Tab, Ctrl-C, arrows.
            </p>
            <p>
              An agent asks to edit the checkout form; you read the diff on the couch, hit yes, and
              put the phone back down. The fleet never knew you left the room.
            </p>
          </div>
        </JobSplit>
      </JobSection>

      <JobSection>
        <JobSplit
          media={
            <div className="space-y-6">
              <JobShot
                src="/product/features/launcher.png"
                width={736}
                height={804}
                alt="The session launcher: shell, claude-code, codex, opencode, aider, and a file explorer"
                caption="The launcher: agents as visible commands."
              />
              <JobShot
                src="/product/features/host-picker.png"
                width={560}
                height={660}
                alt="The host picker listing three machines, all online"
                caption="Any pane, on any machine you own."
              />
            </div>
          }
        >
          <JobH2>Dispatch without ceremony.</JobH2>
          <div className="mt-6 space-y-5">
            <p>
              A new lane is two choices: which machine, which directory. The launcher’s agent
              shortcuts — claude, codex, opencode, aider, or your own — just type the visible
              command into a fresh login shell. No wrapper, no hidden flags, nothing between you and
              the CLI.
            </p>
            <p>
              Because a tile is a real shell, dispatch and repair are the same motion: the pane that
              ran the agent takes <span className="text-bone">git diff</span>,{" "}
              <span className="text-bone">bun test</span>, and a hand-driven fix afterward.
            </p>
          </div>
        </JobSplit>
      </JobSection>

      <JobSection>
        <JobProse>
          <JobH2>Managed doesn’t mean watched.</JobH2>
          <p className="mt-6 max-w-[58ch]">
            Sessions are owned by worker processes on the host, not by your terminal app or the
            browser tab. Close the lid; the fleet keeps working. Lose the wifi, restart the daemon
            itself — the workers hold the PTYs, and the grid picks up where it was, scrollback
            intact.
          </p>
        </JobProse>
        <div className="mx-auto mt-12 w-full max-w-5xl">
          <JobShot
            src="/product/fleet-close.png"
            width={2540}
            height={1920}
            alt="The storefront workspace up close: the agent holding an edit, the cart tests, the dev server, and the diff"
            caption="One project’s workspace, up close: the agent, its tests, the dev server, the diff."
          />
        </div>
      </JobSection>

      <JobSection className="py-8 sm:py-10">
        <JobProse>
          <p className="text-[15px] leading-7">
            Real PTYs owned by host workers. Hosts dial out — zero open ports. Your browser talks to
            each daemon peer-to-peer, end-to-end encrypted. Open source, MIT / Apache-2.0.{" "}
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
