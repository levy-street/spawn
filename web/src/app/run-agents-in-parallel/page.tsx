import type { Metadata } from "next";
import { FleetCapture } from "@/components/seo/templates/FleetCapture";
import {
  JobH2,
  JobMechanics,
  JobPage,
  JobSection,
  JobShellAside,
  JobStart,
  JobTrio,
} from "@/components/seo/templates/JobPage";

/*
 * The flagship job page: the person who runs three to ten agent sessions as
 * a fleet. Hero = heavy branding, minimal words; body = the general
 * capability, one capture as an example, one CTA moment, a quiet FAQ.
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
      hero={{
        title: { plain: "Run multiple Claude Code sessions", accent: "in parallel." },
        sub: "A grid of real terminals across the machines you own — every agent in its own shell, visible from anywhere.",
        ink: { video: "/brand/ink/grid-ink.mp4", poster: "/brand/ink/grid-ink.png" },
      }}
      faq={FAQ}
      related={RELATED}
    >
      <JobSection marker="What this is">
        <p className="max-w-[58ch] text-[clamp(18px,2.1vw,23px)] leading-[1.7] text-bone">
          A workspace is a grid of live terminal sessions — real login shells on machines you own.{" "}
          <span className="text-ash">
            Any CLI agent runs in any tile —{" "}
            <span className="font-sigil text-[0.82em]">claude · codex · opencode · aider</span> —
            and the built-in shortcuts just type the visible command into the shell. One grid can
            mix machines: tiles on the dev box sit beside tiles on the rig and a five-dollar VPS.
          </span>
        </p>
        <div className="mt-16">
          <FleetCapture caption="An example — a workspace: six sessions across three machines" />
        </div>
      </JobSection>

      <JobSection marker="The three problems">
        <JobH2 text={{ plain: "“Just open more terminals”", accent: "fails three ways." }} />
        <div className="mt-14">
          <JobTrio
            items={[
              {
                title: "Isolation",
                body: "Two agents in one checkout fight over the same index and the same build directory. Give every session a directory of its own — one git worktree per agent is the clean pattern — and the isolation is the filesystem’s, not a sandbox’s.",
              },
              {
                title: "Attention",
                body: "A session that needs an answer marks its tile, and the alert can reach your phone. Any device you’ve approved opens the same live terminal, mid-scrollback — a yes is one keystroke.",
              },
              {
                title: "Persistence",
                body: "Sessions are owned by worker processes on the host, not by a browser tab. They survive closed tabs, dropped connections, and restarts of the daemon itself — scrollback intact.",
              },
            ]}
          />
        </div>
      </JobSection>

      <JobMechanics
        fragments={[
          "Real PTYs owned by host workers",
          "Hosts dial out — zero open ports",
          "End-to-end encrypted past our own server",
          "Open source, MIT / Apache-2.0",
        ]}
        link={{ label: "Read the threat model", href: "/security" }}
      />

      <JobStart
        heading={{ plain: "One line on any host", accent: "you own." }}
        aside={
          <JobShellAside title="The clean pattern — one worktree per agent">
            <p className="whitespace-nowrap">
              <span className="text-ember">$</span> git worktree add ../wt/auth -b agents/auth
            </p>
            <p className="whitespace-nowrap">
              <span className="text-ember">$</span> git worktree add ../wt/importer -b
              agents/importer
            </p>
            <p className="whitespace-nowrap">
              <span className="text-ember">$</span> git worktree add ../wt/perf -b agents/perf
            </p>
            <p className="whitespace-nowrap pt-2 text-ash">
              # one directory per session, one agent per tile
            </p>
          </JobShellAside>
        }
      />
    </JobPage>
  );
}
