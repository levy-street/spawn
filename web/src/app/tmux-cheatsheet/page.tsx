import type { Metadata, Viewport } from "next";
import Link from "next/link";
import {
  JOB_LINK,
  JobCodeFigure,
  JobH2,
  JobPage,
  JobProse,
  JobSection,
  JobStart,
} from "@/components/seo/templates/JobPage";
import { Cheatsheet } from "./Cheatsheet";
import { TMUX_COMMANDS } from "./tmux-commands";

/*
 * A reference page on the job frame: a short teach-first intro, then the
 * whole cheatsheet server-rendered under section H2s (the island only
 * filters), then one closing section on what tmux's persistence is and
 * isn't — where the product enters, honestly, and not before.
 */

const TITLE = "tmux cheatsheet: sessions, windows, panes, and the fixes";
const DESCRIPTION =
  "Every tmux command you actually reach for — new, attach, detach, list, rename, kill all sessions, splits, copy mode, .tmux.conf, scripting — checked against the man page.";
const PATH = "/tmux-cheatsheet";
const OG_IMAGE = "/og/tmux-cheatsheet.jpg";
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
    q: "How do I kill all tmux sessions?",
    a: "tmux kill-server — it stops the server and every session and client on it. To keep one, tmux kill-session -a -t name kills all the others. Neither asks for confirmation.",
  },
  {
    q: "Why did my tmux sessions disappear after a reboot?",
    a: "Because a tmux session is a process, not a file. The server dies with the machine and takes every session with it; what survives is only what a plugin like tmux-resurrect saved beforehand, and that is the layout and the commands, not their state. Anything that must outlive a reboot has to be started again by something — a login script, a systemd unit, or a daemon built for it.",
  },
  {
    q: "What is the difference between detaching and exiting?",
    a: "Detach (C-b d) drops your terminal off the session and leaves everything running; you come back with tmux attach. Exit closes the shell in the pane; when the last pane of the last window goes, the session and, if it was the last session, the server go too.",
  },
];

const RELATED = [
  {
    title: "spawnd vs SSH + tmux",
    blurb: "the classic taken seriously — where it runs out and what changes",
    href: "/spawnd-vs-ssh-and-tmux",
  },
  {
    title: "Keep agents running",
    blurb: "what happens to a session when the laptop closes",
    href: "/use/keep-agents-running",
  },
  {
    title: "Run agents in parallel",
    blurb: "the panes-and-worktrees setup, and the management problem after it",
    href: "/run-agents-in-parallel",
  },
];

export default function TmuxCheatsheetPage() {
  return (
    <JobPage
      crumbs={[{ name: "Guides", href: "/guides" }]}
      pageName="tmux cheatsheet"
      canonicalPath={PATH}
      hero={{
        title: { plain: "tmux cheatsheet:", accent: "sessions, windows, panes" },
        sub: `${TMUX_COMMANDS.length} commands and the fixes for the messages tmux prints — every one checked against the man page, with a filter box and a copy button each.`,
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
          <JobH2>One server, sessions, windows, panes — and a prefix.</JobH2>
          <div className="mt-8 space-y-5">
            <p>
              tmux is a terminal multiplexer: one program that holds many terminals and shows you
              some of them. The shape is a tree. A single{" "}
              <em className="not-italic text-bone">server</em> process runs per user; it manages{" "}
              <em className="not-italic text-bone">sessions</em>; each session has{" "}
              <em className="not-italic text-bone">windows</em> (tabs, in effect); each window is
              split into <em className="not-italic text-bone">panes</em>, and every pane is a real
              terminal with its own shell. Your terminal emulator is only a{" "}
              <em className="not-italic text-bone">client</em> looking at one session. Close it,
              lose the SSH connection, walk away: the server and everything in it keep running, and{" "}
              <code>tmux attach</code> puts you back where you were.
            </p>
            <p>
              You talk to tmux with a prefix key — <kbd className="font-sigil text-bone">C-b</kbd>{" "}
              by default, Ctrl and b together, released — followed by one command key, or with
              commands typed at a shell (<code>tmux …</code>) or at tmux’s own prompt (
              <kbd className="font-sigil text-bone">C-b :</kbd>). The key bindings and the commands
              are the same operations; the cheatsheet lists both wherever both exist.
            </p>
          </div>
          <div className="mt-10">
            <JobCodeFigure refId="a1" caption="The three commands that cover most days.">
              <p className="whitespace-nowrap">
                <span className="text-ash">$</span> tmux new -A -s work
                <span className="text-ash"> # start it, or attach if it exists</span>
              </p>
              <p className="whitespace-nowrap">
                <span className="text-ash">C-b d</span>
                <span className="text-ash"> # detach; the session keeps running</span>
              </p>
              <p className="whitespace-nowrap">
                <span className="text-ash">$</span> tmux ls
                <span className="text-ash"> # what is running under your user</span>
              </p>
            </JobCodeFigure>
          </div>
        </JobProse>
      </JobSection>

      <JobSection refId="s2" className="pt-0 sm:pt-0">
        <Cheatsheet />
      </JobSection>

      <JobSection refId="s3">
        <JobProse>
          <JobH2>Persistence in tmux is a discipline.</JobH2>
          <div className="mt-8 space-y-5">
            <p>
              Look at what the persistence actually rests on. A session survives your terminal
              closing because the server is a separate process — but only the terminals started{" "}
              <em className="not-italic text-bone">inside</em> it. The build you ran in a plain
              shell before you remembered to type <code>tmux</code> dies with the window. The agent
              you launched over SSH without attaching first is gone when the connection is. And the
              server itself is a process on one machine: a reboot, an OOM kill, a{" "}
              <code>kill-server</code> in the wrong terminal, and every session is gone — which is
              what the troubleshooting section above is mostly about. So tmux persistence is a habit
              you keep, per machine, every time: start inside it, name it, remember which box it
              lives on, and reach that box over SSH when you want it back.
            </p>
            <p>
              For one machine you sit at, that habit is enough, and nothing on this page suggests
              otherwise. It stops being enough when the sessions are agents that run for hours,
              across several machines, and you are not at any of them. That is the case where the
              other design earns its place: sessions that are persistent by construction rather than
              by discipline. In spawnd, a small daemon on each host you own owns every session — a
              worker process holds each PTY — so a session survives the closed tab, the dropped
              connection, the laptop lid, and a restart of the daemon itself, scrollback intact.
              There is no “did I start this inside tmux?”, because there is no wrong way to start
              one. The daemon dials out, so nothing listens on the host and no VPN is needed; any
              browser is the console, and on a phone it installs to the home screen as a web app —
              the same live terminal, mid-scrollback. tmux still runs fine inside a tile if you like
              it as a layout tool; it just stops being load-bearing.
            </p>
            <p>
              <Link prefetch={false} href="/spawnd-vs-ssh-and-tmux" className={JOB_LINK}>
                spawnd vs SSH + tmux
              </Link>{" "}
              is the row-by-row comparison, including where the classic is still the right answer;{" "}
              <Link prefetch={false} href="/use/keep-agents-running" className={JOB_LINK}>
                keeping agents running
              </Link>{" "}
              is the job it was built for.
            </p>
          </div>
        </JobProse>
      </JobSection>

      <JobSection refId="s4" className="py-8 sm:py-10">
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

      <JobStart heading="Persistence without the prefix." />
    </JobPage>
  );
}
