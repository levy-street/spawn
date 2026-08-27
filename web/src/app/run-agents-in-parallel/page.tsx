import type { Metadata } from "next";
import { FleetCapture } from "@/components/seo/templates/FleetCapture";
import { JobPage, JobPlate, JobSection, JobShellFigure } from "@/components/seo/templates/JobPage";

/*
 * The flagship job page: the person who runs three to ten agent sessions as a
 * fleet, whose real problem is that the fleet is invisible and interruptible.
 * Primary ICP: the agent power user — dense, specific, zero hand-holding.
 * Every claim survives a diff against docs/TRUST.md and README.md.
 */

const TITLE = "Run multiple Claude Code sessions in parallel";
const DESCRIPTION =
  "Run Claude Code, Codex, and aider in parallel — one grid of live terminals across your machines: a worktree per tile, real PTYs that survive the closed laptop.";
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
    q: "How many agent sessions can one workspace hold?",
    a: "There’s no product cap. The real limit is the hosts: every session is a login shell plus whatever its agent burns, running on your machine. When one box gets hot, add tiles from another host to the same grid.",
  },
  {
    q: "Do I still need tmux underneath?",
    a: "No. Persistence is structural: each session’s PTY is owned by a worker process on the host, so it survives the closed tab, the dropped connection, even a restart of the daemon itself — scrollback intact. If you like tmux as a layout tool it runs fine inside a tile; it just stops being load-bearing.",
  },
  {
    q: "How do parallel Claude Code sessions stay out of each other’s way?",
    a: "Give each one its own directory — one git worktree per session is the clean version. A session starts your login shell in the directory you choose, so the isolation is the filesystem’s, not a sandbox’s. Each CLI authenticates itself on the host; spawnd never holds your provider keys.",
  },
  {
    q: "Can tiles in one grid live on different machines?",
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
    family: "Use cases",
    title: "Keep agents running",
    blurb: "what happens to the fleet when the laptop closes",
    href: "/use/keep-agents-running",
  },
  {
    family: "Use cases",
    title: "AI agents on your own GPU",
    blurb: "the rig as a first-class host in the grid",
    href: "/use/ai-agents-on-your-own-gpu",
  },
  {
    family: "Agents",
    title: "Claude Code",
    blurb: "the pillar page for the CLI itself",
    href: "/for/claude-code",
  },
  {
    family: "Use cases",
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
      heading={{ plain: "Run multiple Claude Code sessions", accent: "in parallel." }}
      lede={
        <>
          <p>
            Six agents, three machines, one grid. Claude&nbsp;Code reworks auth in the first tile
            and grinds the test suite in the third; Codex has the importer on the rig. When a tile
            needs a yes, it glows. Everything else keeps running.
          </p>
          <p>
            spawnd runs parallel Claude&nbsp;Code sessions — or Codex, opencode, aider, any CLI
            agent — as one workspace of live terminals: real shells on machines you own, reachable
            from any browser you’ve approved.
          </p>
        </>
      }
      vignette={<FleetCapture />}
      faq={FAQ}
      related={RELATED}
      closing={{
        heading: { plain: "Your agents are already parallel.", accent: "See them." },
        body: "One command possesses a host; one workspace holds the fleet. Open source, MIT and Apache-2.0 — and the server that introduces your devices can’t read a single tile.",
      }}
    >
      <JobSection
        index="01"
        eyebrow="The lanes"
        heading={{ plain: "One worktree per agent.", accent: "One tile per worktree." }}
        aside={
          <JobShellFigure title="The lanes, cut in three commands">
            <p className="whitespace-nowrap">
              <span className="text-ember">$</span> git worktree add ../api.wt/auth -b agents/auth
            </p>
            <p className="whitespace-nowrap">
              <span className="text-ember">$</span> git worktree add ../api.wt/importer -b
              agents/importer
            </p>
            <p className="whitespace-nowrap">
              <span className="text-ember">$</span> git worktree add ../api.wt/perf -b agents/perf
            </p>
            <p className="whitespace-nowrap pt-3 text-ash"># one session per directory, then —</p>
            <p className="whitespace-nowrap">
              <span className="text-ember">$</span> claude{" "}
              <span className="text-ash"># tile 1 · dream</span>
            </p>
            <p className="whitespace-nowrap">
              <span className="text-ember">$</span> codex{" "}
              <span className="text-ash"># tile 2 · rig</span>
            </p>
            <p className="whitespace-nowrap">
              <span className="text-ember">$</span> claude{" "}
              <span className="text-ash"># tile 3 · rig</span>
            </p>
          </JobShellFigure>
        }
      >
        <p>
          Parallel agents fail at the filesystem first: two sessions in one checkout fight over the
          same index and the same build directory. Worktrees end it — one checkout per branch, all
          off one clone. spawnd doesn’t wrap that workflow. A session is your login shell, started
          in the directory you name, so one worktree per tile is just what naming directories gets
          you.
        </p>
        <p>
          Dispatch is typing. Open a session per lane and hit the claude shortcut in each — it types
          the visible command, nothing more. The same tile takes{" "}
          <code className="font-sigil text-[14px] text-bone">git diff</code>,{" "}
          <code className="font-sigil text-[14px] text-bone">bun test</code>, and a hand-driven vim
          rescue, because a tile isn’t a viewer pointed at the agent. It’s the shell the agent runs
          in.
        </p>
      </JobSection>

      <JobPlate
        index="02"
        eyebrow="The mechanics"
        heading={{ plain: "Built for the hours you’re not watching." }}
        lede="Not a dashboard bolted over your agents — the shell they already run in, held open while you’re elsewhere."
        items={[
          {
            title: "Workers own the PTYs",
            body: "Each session’s PTY belongs to a worker process on the host, not to a browser tab. Close the laptop, lose the wifi, restart the daemon itself — the shell keeps running, and the tile comes back with scrollback intact.",
          },
          {
            title: "Hosts mix in one grid",
            body: "A tile doesn’t care where it lives. The dev box, the GPU rig, and a five-dollar VPS sit side by side in one workspace, and every tile talks directly to its own host.",
          },
          {
            title: "The ask finds you",
            body: "A stalled agent marks its tile and the sidebar, and alerts can reach your phone. Any approved device opens the same grid, mid-scrollback — answering is typing, not remoting in.",
          },
          {
            title: "The wire stays sealed",
            body: "Terminal bytes run browser to daemon, end-to-end encrypted; the server cannot read a tile, and a forced relay forwards only ciphertext. Hosts dial out — ten agents deep, zero open ports.",
          },
        ]}
      />

      <JobSection
        index="03"
        eyebrow="The bottleneck"
        heading={{ plain: "Parallelism is an interrupt problem." }}
        aside={
          <JobShellFigure title="The three interrupts">
            <div className="grid min-w-[520px] grid-cols-[auto_auto_minmax(0,1fr)] gap-x-6 gap-y-3">
              <span className="text-ember">agent.awaiting_input</span>
              <span className="text-bone">claude · dream</span>
              <span className="text-ash">a permission prompt, holding for you</span>
              <span className="text-ember">agent.finished</span>
              <span className="text-bone">codex · rig</span>
              <span className="text-ash">the run ended; the diff is ready</span>
              <span className="text-ember">session.died</span>
              <span className="text-bone">aider · mini</span>
              <span className="text-ash">exit 137 now — not tomorrow morning</span>
            </div>
          </JobShellFigure>
        }
      >
        <p>
          The ceiling on a fleet was never compute — it’s how long a question waits for you. An
          agent stalled on a permission prompt is a serial agent with extra steps. The grid inverts
          it: the session raises the event, the event finds whichever device you’re holding, you
          answer, it runs on.
        </p>
        <p>
          Those three events are the product’s entire telemetry ambition. The server that routes
          them sees that an agent stirred, never what it said — terminal content isn’t in its
          vocabulary, by construction.
        </p>
      </JobSection>
    </JobPage>
  );
}
