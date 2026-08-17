"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronRight,
  Flame,
  Ghost,
  KeyRound,
  Lock,
  Server,
  Smartphone,
  Terminal,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AgentListRow } from "@/components/agents/AgentListRow";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { type Agent, agents, type Host, hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function HomePage() {
  const { user } = useAuth();

  if (user) {
    return (
      <AppShell>
        <Dashboard />
      </AppShell>
    );
  }

  return <LandingPage />;
}

function LandingPage() {
  const [origin, setOrigin] = useState("https://spawnd.dev");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const installCommand = `curl -fsSL ${origin}/install.sh | sh`;

  return (
    <main className="grimoire min-h-vv overflow-hidden">
      {/* ── Hero ─────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden border-line-g border-b">
        <Image
          src="/possession.png"
          alt=""
          aria-hidden
          fill
          priority
          sizes="100vw"
          className="pointer-events-none object-cover object-[70%_center] opacity-90"
        />
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, rgba(10,6,7,.96) 0%, rgba(10,6,7,.9) 28%, rgba(10,6,7,.5) 58%, rgba(10,6,7,.22) 100%), linear-gradient(180deg, rgba(10,6,7,.55) 0%, transparent 16%, transparent 72%, rgba(10,6,7,.92) 100%)",
          }}
        />

        <nav className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-6 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <Sigil className="size-7" />
            <span className="font-sigil text-[15px] tracking-[0.3em] text-hellfire lowercase">
              spawnd
            </span>
          </Link>
          <div className="flex items-center gap-4 font-sigil text-[12px] tracking-[0.18em] uppercase sm:gap-5">
            <Link
              href="/veil"
              className="hidden text-ash transition-colors hover:text-bone sm:inline"
            >
              The&nbsp;Veil
            </Link>
            <Link
              href="/login"
              className="hidden text-ash transition-colors hover:text-bone sm:inline"
            >
              Log&nbsp;in
            </Link>
            <Link
              href="/signup"
              className="rounded-sm border border-hellfire/60 px-3 py-1.5 text-ember transition-colors hover:border-hellfire hover:text-hellfire"
            >
              Sign&nbsp;up
            </Link>
          </div>
        </nav>

        <div className="relative z-10 mx-auto flex min-h-[86svh] w-full max-w-6xl flex-col justify-center px-5 pt-10 pb-20 sm:px-8">
          <p className="mb-6 font-sigil text-[12px] tracking-[0.34em] text-hellfire uppercase">
            <span className="text-ash">daemon</span> · <span className="text-ash">host</span> ·
            possession
          </p>
          <h1 className="max-w-3xl font-grimoire text-[clamp(44px,9vw,92px)] font-medium leading-[0.98] text-bone [text-wrap:balance]">
            Possess your machines.
          </h1>
          <p className="mt-7 max-w-[54ch] text-[18px] leading-8 text-ash sm:text-[19px]">
            The open-source control plane that possesses every machine you own with a single daemon
            — <em className="text-bone not-italic">summon, drive, and banish</em> CLI coding agents
            from any browser, including your phone, while the server that coordinates it all is{" "}
            <em className="text-bone not-italic">
              structurally unable to read a byte of your terminal.
            </em>
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              href="/signup"
              className="group inline-flex items-center justify-center gap-2 rounded-sm bg-hellfire px-6 py-3.5 font-sigil text-[13px] tracking-[0.14em] text-void uppercase transition-colors hover:bg-ember"
            >
              Begin the possession
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/veil"
              className="inline-flex items-center justify-center gap-2 rounded-sm border border-line-strong px-6 py-3.5 font-sigil text-[13px] tracking-[0.14em] text-bone uppercase transition-colors hover:border-ember hover:text-ember"
            >
              Read the threat model
            </Link>
          </div>

          <div className="mt-8 inline-flex max-w-full items-center gap-3 overflow-x-auto rounded-sm border border-line-g bg-char/80 px-4 py-3 font-sigil text-[13px] text-bone backdrop-blur-sm">
            <span className="text-hellfire">$</span>
            <code className="whitespace-nowrap">{installCommand}</code>
            <span className="whitespace-nowrap text-ash">
              &nbsp;&nbsp;# the possession takes one line
            </span>
          </div>
        </div>
      </section>

      {/* ── Pillars ──────────────────────────────────────────── */}
      <section className="border-line-g border-b px-5 py-24 sm:px-8">
        <div className="mx-auto w-full max-w-6xl">
          <p className="mb-3 font-sigil text-[12px] tracking-[0.3em] text-hellfire uppercase">
            One roof, three pillars
          </p>
          <h2 className="mb-14 max-w-2xl font-grimoire text-[clamp(28px,4.4vw,40px)] font-medium leading-[1.12] text-bone">
            A demon in your house that answers only to you.
          </h2>
          <div className="grid gap-px overflow-hidden rounded-md border border-line-g bg-line-g md:grid-cols-3">
            <Pillar
              icon={<Server className="size-5" />}
              kicker="Sovereignty"
              title="The demon lives in your house."
            >
              Agents run on hardware you own, signed into the subscriptions you already pay for.
              Each CLI does its own <code className="text-ember">claude /login</code>. We never
              touch your API keys, because we never <em className="text-bone not-italic">have</em>{" "}
              them.
            </Pillar>
            <Pillar
              icon={<Lock className="size-5" />}
              kicker="Silence"
              title="It answers only to you."
            >
              Terminal I/O runs end-to-end encrypted, browser to daemon, over WebRTC. The control
              plane carries signaling only — there is no server code path for terminal content. The
              server <em className="text-bone not-italic">cannot</em> read your terminal.
              Cryptography, not a pinky promise.
            </Pillar>
            <Pillar
              icon={<Smartphone className="size-5" />}
              kicker="Ubiquity"
              title="Any demon, any host, any circle."
            >
              claude, codex, opencode, aider, a bare shell — if it runs in a PTY, it can be
              possessed. macOS and Linux hosts, one installer, outbound-only. The real TUI over
              xterm.js, phone in hand, a second device taking control mid-keystroke.
            </Pillar>
          </div>
        </div>
      </section>

      {/* ── The objection / inversion ────────────────────────── */}
      <section className="relative overflow-hidden border-line-g border-b px-5 py-24 sm:px-8">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 70% 60% at 50% 120%, rgba(142,31,22,.4), transparent 62%)",
          }}
        />
        <div className="relative mx-auto w-full max-w-3xl text-center">
          <Flame className="mx-auto mb-6 size-8 text-hellfire" aria-hidden />
          <p className="mb-3 font-sigil text-[12px] tracking-[0.3em] text-hellfire uppercase">
            The objection
          </p>
          <h2 className="mb-7 font-grimoire text-[clamp(26px,4.4vw,38px)] font-medium leading-[1.15] text-bone">
            “This is literally what malware does.”
          </h2>
          <p className="mx-auto max-w-[62ch] text-[17px] leading-8 text-ash">
            A botnet is possession <em className="text-bone not-italic">without</em> consent, run
            from a C2 server that reads everything. spawnd is the inversion on every axis:{" "}
            <span className="text-bone">you</span> run the installer,{" "}
            <span className="text-bone">you</span> approve the pairing ceremony against a key
            fingerprint, and the coordinating server is engineered to be unable to read the session.
            The daemon opens no inbound ports; it only dials out. Revocation is one click and the
            socket dies. And it is open source — so you don’t have to take a single sentence of this
            on faith, including this one.
          </p>
          <p className="mt-8 font-sigil text-[13px] tracking-[0.08em] text-ember">
            We simply reversed every axis of evil.
          </p>
        </div>
      </section>

      {/* ── Lexicon: every term teaches a mechanism ──────────── */}
      <section className="border-line-g border-b px-5 py-24 sm:px-8">
        <div className="mx-auto w-full max-w-6xl">
          <p className="mb-3 font-sigil text-[12px] tracking-[0.3em] text-hellfire uppercase">
            The lexicon
          </p>
          <h2 className="mb-4 max-w-2xl font-grimoire text-[clamp(28px,4.4vw,40px)] font-medium leading-[1.12] text-bone">
            Every term earns its mechanism.
          </h2>
          <p className="mb-12 max-w-[60ch] text-[16px] leading-7 text-ash">
            The theme is a mnemonic system, not paint. A word is admitted only if it teaches real
            architecture. If it maps to nothing, it gets cut.
          </p>
          <div className="grid gap-px overflow-hidden rounded-md border border-line-g bg-line-g sm:grid-cols-2">
            <Lex icon={<Ghost className="size-4" />} term="revenants">
              Session workers that survive the daemon’s death and are re-adopted on restart. Your
              agent outlives its daemon; the work does not stop.
            </Lex>
            <Lex icon={<KeyRound className="size-4" />} term="the sigil">
              An Ed25519 key fingerprint. You verify the sigil before trust is granted; a changed
              sigil is refused, loudly.
            </Lex>
            <Lex icon={<Lock className="size-4" />} term="the veil">
              The control plane. It introduces your browser to the daemon, then goes deaf —
              signaling only, never content.
            </Lex>
            <Lex icon={<Terminal className="size-4" />} term="the circle">
              The terminal pane — the summoning circle where the agent appears. A real PTY, the raw
              TUI, every keybinding and color intact.
            </Lex>
          </div>
        </div>
      </section>

      {/* ── Silence / claims ─────────────────────────────────── */}
      <section className="border-line-g border-b px-5 py-24 sm:px-8">
        <div className="mx-auto grid w-full max-w-6xl gap-12 lg:grid-cols-[1fr_1fr] lg:items-center">
          <div>
            <p className="mb-3 font-sigil text-[12px] tracking-[0.3em] text-hellfire uppercase">
              We introduce. We never listen.
            </p>
            <h2 className="mb-6 font-grimoire text-[clamp(28px,4.4vw,40px)] font-medium leading-[1.12] text-bone">
              End-to-end encrypted, browser to daemon.
            </h2>
            <p className="max-w-[56ch] text-[17px] leading-8 text-ash">
              Session traffic runs directly between your browser and the daemon over encrypted
              WebRTC DataChannels. The relay is a fallback only — when NAT demands it, TURN carries
              ciphertext it cannot decrypt. Either way, there is no server code path for terminal
              content, no transcript store, nothing to subpoena. The threat model in the repo names
              our own infrastructure as an adversary, because you should treat it as one.
            </p>
          </div>
          <ul className="space-y-px overflow-hidden rounded-md border border-line-g bg-line-g">
            <Claim>Terminal traffic never touches our server in plaintext.</Claim>
            <Claim>
              The relay, when NAT forces one, carries only ciphertext it cannot decrypt.
            </Claim>
            <Claim>No inbound ports. No exposed SSH. No tailnet. The daemon dials out.</Claim>
            <Claim>No central credential store — each agent uses its own login on the host.</Claim>
            <Claim>Consensual. Auditable. Revocable — one click and the socket dies.</Claim>
          </ul>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-5 py-28 sm:px-8">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(255,73,48,.1), transparent 60%)",
          }}
        />
        <div className="relative mx-auto w-full max-w-3xl text-center">
          <Sigil className="mx-auto mb-8 size-16" />
          <h2 className="mb-5 font-grimoire text-[clamp(32px,5.5vw,52px)] font-medium leading-[1.05] text-bone">
            Your legion awaits.
          </h2>
          <p className="mx-auto mb-9 max-w-[46ch] text-[17px] leading-8 text-ash">
            One line to possess the first host. A ceremony you control, a key you verify, a demon
            that answers only to you.
          </p>
          <div className="mb-8 inline-flex max-w-full items-center gap-3 overflow-x-auto rounded-sm border border-line-g bg-char px-4 py-3 font-sigil text-[13px] text-bone">
            <span className="text-hellfire">$</span>
            <code className="whitespace-nowrap">{installCommand}</code>
          </div>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="group inline-flex items-center justify-center gap-2 rounded-sm bg-hellfire px-7 py-3.5 font-sigil text-[13px] tracking-[0.14em] text-void uppercase transition-colors hover:bg-ember"
            >
              Begin the possession
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/download"
              className="inline-flex items-center justify-center gap-2 rounded-sm border border-line-strong px-7 py-3.5 font-sigil text-[13px] tracking-[0.14em] text-bone uppercase transition-colors hover:border-ember hover:text-ember"
            >
              Possess a host
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-line-g border-t px-5 py-10 sm:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 font-sigil text-[12px] tracking-[0.08em] text-ash sm:flex-row">
          <span>
            <span className="text-hellfire">spawnd</span> · consensual · auditable · revocable
          </span>
          <div className="flex items-center gap-5">
            <Link href="/veil" className="transition-colors hover:text-bone">
              The Veil
            </Link>
            <Link href="/download" className="transition-colors hover:text-bone">
              Install
            </Link>
            <Link href="/login" className="transition-colors hover:text-bone">
              Log in
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Pillar({
  icon,
  kicker,
  title,
  children,
}: {
  icon: ReactNode;
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-void p-8">
      <div className="mb-5 flex size-10 items-center justify-center rounded-sm border border-hellfire/40 text-hellfire">
        {icon}
      </div>
      <p className="mb-2 font-sigil text-[11px] tracking-[0.24em] text-ember uppercase">{kicker}</p>
      <h3 className="mb-3 font-grimoire text-[21px] font-medium leading-tight text-bone">
        {title}
      </h3>
      <p className="text-[15px] leading-7 text-ash">{children}</p>
    </div>
  );
}

function Lex({ icon, term, children }: { icon: ReactNode; term: string; children: ReactNode }) {
  return (
    <div className="bg-void p-7">
      <div className="mb-3 flex items-center gap-3">
        <span className="text-hellfire">{icon}</span>
        <span className="font-sigil text-[14px] tracking-[0.06em] text-hellfire">{term}</span>
      </div>
      <p className="text-[15px] leading-7 text-ash">{children}</p>
    </div>
  );
}

function Claim({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 bg-void px-6 py-4 text-[15px] leading-7 text-bone">
      <Flame className="mt-1 size-3.5 shrink-0 text-hellfire" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

/** The brand sigil — concentric rings of a key fingerprint around the wordmark. */
function Sigil({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 250 250" className={className} aria-hidden role="img">
      <title>spawnd sigil</title>
      <defs>
        <path id="sigilRingA" d="M125,125 m-96,0 a96,96 0 1,1 192,0 a96,96 0 1,1 -192,0" />
        <path id="sigilRingB" d="M125,125 m-70,0 a70,70 0 1,1 140,0 a70,70 0 1,1 -140,0" />
      </defs>
      <circle
        cx="125"
        cy="125"
        r="106"
        fill="none"
        stroke="rgba(233,225,211,.16)"
        strokeWidth="1"
      />
      <circle cx="125" cy="125" r="58" fill="none" stroke="rgba(255,73,48,.35)" strokeWidth="1" />
      <g className="grimoire-ring">
        <text
          fontFamily="ui-monospace,Menlo,monospace"
          fontSize="9.5"
          letterSpacing="3"
          fill="#FF4930"
          opacity=".8"
        >
          <textPath href="#sigilRingA">
            ed25519 4f:9a:c3:e1:0b:77:d2:5c:88:1a:f0:63:be:2d:41:97:6e:0c:a5:3f
          </textPath>
        </text>
      </g>
      <g className="grimoire-ring-rev">
        <text
          fontFamily="ui-monospace,Menlo,monospace"
          fontSize="8"
          letterSpacing="2.5"
          fill="#A89B8E"
          opacity=".6"
        >
          <textPath href="#sigilRingB">
            no inbound ports · outbound only · the server never hears ·
          </textPath>
        </text>
      </g>
      <text
        x="125"
        y="132"
        textAnchor="middle"
        fontFamily="ui-monospace,Menlo,monospace"
        fontSize="30"
        letterSpacing="1"
        fill="#E9E1D3"
      >
        d
      </text>
    </svg>
  );
}

function Dashboard() {
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, refetchInterval: 30_000 });
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => agents.list(),
    refetchInterval: 5_000,
  });
  const recentAgents = [...(agentsQ.data ?? [])]
    .sort((a, b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? ""))
    .slice(0, 6);

  return (
    <div className="mx-auto w-full max-w-5xl p-4 @container/dash">
      <header className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <Button asChild size="sm">
          <Link href="/agents/new">Summon</Link>
        </Button>
      </header>

      <section className="grid gap-4 @md/dash:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <div className="min-w-0">
              <CardTitle>Hosts</CardTitle>
              <CardDescription>
                {hostsQ.isLoading
                  ? "Loading…"
                  : hostsQ.error
                    ? "Failed to load hosts"
                    : `${hostsQ.data?.length ?? 0} possessed`}
              </CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm" className="shrink-0 text-muted-foreground">
              <Link href="/hosts">All</Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="border-t border-border">
              {(hostsQ.data ?? []).slice(0, 5).map((h: Host) => (
                <li key={h.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={`/hosts/${h.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
                  >
                    <StatusDot
                      tone={hostStatusTone(h.status)}
                      label={h.status}
                      pulse={h.status === "online"}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{h.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {h.agent_count} agent{h.agent_count === 1 ? "" : "s"}
                    </span>
                    <ChevronRight
                      className="size-4 shrink-0 text-muted-foreground/50"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
              {!hostsQ.isLoading && (hostsQ.data?.length ?? 0) === 0 && (
                <li className="px-4 py-3 text-sm text-muted-foreground">
                  No hosts possessed yet. Run <code>spawnd login</code> on a machine and approve it
                  at{" "}
                  <Link href="/device" className="underline">
                    /device
                  </Link>
                  .
                </li>
              )}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <div className="min-w-0">
              <CardTitle>Recent agents</CardTitle>
              <CardDescription>
                {agentsQ.isLoading
                  ? "Loading…"
                  : agentsQ.error
                    ? "Failed to load agents"
                    : `${agentsQ.data?.length ?? 0} in the legion`}
              </CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm" className="shrink-0 text-muted-foreground">
              <Link href="/agents">All</Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="border-t border-border">
              {recentAgents.map((a: Agent) => (
                <AgentListRow key={a.id} agent={a} href={`/agents/${a.id}`} />
              ))}
              {!agentsQ.isLoading && recentAgents.length === 0 && (
                <li className="px-4 py-3 text-sm text-muted-foreground">No agents summoned yet.</li>
              )}
            </ul>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
