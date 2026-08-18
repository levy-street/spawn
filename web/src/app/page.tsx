"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, Flame, Server, Smartphone } from "lucide-react";
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
          src="/hero-poster.jpg"
          alt=""
          aria-hidden
          fill
          priority
          sizes="100vw"
          className="pointer-events-none object-cover object-[58%_center] opacity-90"
        />
        <video
          className="pointer-events-none absolute inset-0 h-full w-full object-cover object-[58%_center] opacity-90 motion-reduce:hidden"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster="/hero-poster.jpg"
          aria-hidden
        >
          <source src="/hero.mp4" type="video/mp4" />
        </video>
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
            <Trident className="size-7" />
            <span className="font-sigil text-[15px] tracking-[0.3em] text-hellfire lowercase">
              spawnd
            </span>
          </Link>
          <div className="flex items-center gap-4 font-sigil text-[12px] tracking-[0.18em] uppercase sm:gap-5">
            <Link
              href="/security"
              className="hidden text-ash transition-colors hover:text-bone sm:inline"
            >
              Security
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
          <p className="mb-6 font-sigil text-[13px] tracking-[0.12em] text-ash">
            Open-source control plane for CLI coding agents
          </p>
          <h1 className="max-w-3xl font-grimoire text-[clamp(42px,8vw,84px)] font-medium leading-[1.0] text-bone [text-wrap:balance]">
            A daemon on every host you own.
          </h1>
          <p className="mt-7 max-w-[56ch] text-[18px] leading-8 text-ash sm:text-[19px]">
            It <em className="text-bone not-italic">answers only to you</em>. Summon your agents
            onto hosts you own and reach them from any browser — the server that connects you{" "}
            <em className="text-bone not-italic">never hears a word</em>.
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              href="/download"
              className="group inline-flex items-center justify-center gap-2 rounded-sm bg-hellfire px-6 py-3.5 font-sigil text-[13px] tracking-[0.14em] text-void uppercase transition-colors hover:bg-ember"
            >
              Install the daemon
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/security"
              className="inline-flex items-center justify-center gap-2 rounded-sm border border-line-strong px-6 py-3.5 font-sigil text-[13px] tracking-[0.14em] text-bone uppercase transition-colors hover:border-ember hover:text-ember"
            >
              Read the threat model
            </Link>
          </div>

          <div className="mt-8 inline-flex max-w-full items-center gap-3 overflow-x-auto rounded-sm border border-line-g bg-char/80 px-4 py-3 font-sigil text-[13px] text-bone backdrop-blur-sm">
            <span className="text-hellfire">$</span>
            <code className="whitespace-nowrap">{installCommand}</code>
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────── */}
      <section className="border-line-g border-b px-5 py-24 sm:px-8">
        <div className="mx-auto w-full max-w-6xl">
          <p className="mb-12 font-sigil text-[12px] tracking-[0.3em] text-hellfire uppercase">
            How it works
          </p>
          <div className="grid gap-px overflow-hidden rounded-md border border-line-g bg-line-g md:grid-cols-3">
            <Step icon={<Server className="size-5" />} title="One daemon per host.">
              Installs with a line. It dials out — no inbound ports, no SSH, no tailnet — and
              registers the host as yours.
            </Step>
            <Step icon={<Flame className="size-5" />} title="Summon agents into it.">
              claude, codex, opencode, aider, a bare shell — anything that runs in a PTY. Each runs
              on your hardware, on the subscriptions you already pay for. We never hold your keys.
            </Step>
            <Step icon={<Smartphone className="size-5" />} title="Reach them from anywhere.">
              The real terminal, in any browser, down to the one in your pocket. A second device can
              take the session mid-keystroke.
            </Step>
          </div>
        </div>
      </section>

      {/* ── It answers only to you ───────────────────────────── */}
      <section className="border-line-g border-b px-5 py-24 sm:px-8">
        <div className="mx-auto w-full max-w-6xl">
          <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:items-center">
            <div>
              <p className="mb-3 font-sigil text-[12px] tracking-[0.3em] text-hellfire uppercase">
                It answers only to you
              </p>
              <h2 className="mb-6 font-grimoire text-[clamp(28px,4.4vw,40px)] font-medium leading-[1.12] text-bone">
                The server can’t read your terminal.
              </h2>
              <p className="max-w-[56ch] text-[17px] leading-8 text-ash">
                Your terminal runs straight from the browser to the daemon, end-to-end encrypted.
                When your network forces a relay, it carries ciphertext the relay can’t read. No
                server-side path to your terminal, no transcript, nothing to hand over — and the
                threat model names our own servers as the adversary, because you should treat them
                as one.
              </p>
            </div>
            <ul className="space-y-px overflow-hidden rounded-md border border-line-g bg-line-g">
              <Claim>No plaintext ever reaches our servers.</Claim>
              <Claim>No inbound ports, no SSH, no tailnet — the daemon dials out.</Claim>
              <Claim>No credential store — every agent uses its own login.</Claim>
              <Claim>Revoke a host and the socket dies.</Claim>
            </ul>
          </div>
          <p className="mx-auto mt-14 max-w-[62ch] text-center font-grimoire text-[19px] text-ash italic leading-[1.4]">
            A daemon that dials out and answers to one master sounds ominous — until you notice the
            master is you.
          </p>
        </div>
      </section>

      {/* ── Close ────────────────────────────────────────────── */}
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
          <Trident className="mx-auto mb-8 size-16" />
          <h2 className="mb-5 font-grimoire text-[clamp(32px,5.5vw,52px)] font-medium leading-[1.05] text-bone">
            Bring a host online.
          </h2>
          <p className="mx-auto mb-9 max-w-[48ch] text-[17px] leading-8 text-ash">
            One line installs the daemon; you approve it against a fingerprint you can see. From
            then on, it answers only to you.
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
              Sign up
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/download"
              className="inline-flex items-center justify-center gap-2 rounded-sm border border-line-strong px-7 py-3.5 font-sigil text-[13px] tracking-[0.14em] text-bone uppercase transition-colors hover:border-ember hover:text-ember"
            >
              Install the daemon
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
            <Link href="/security" className="transition-colors hover:text-bone">
              Security
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

function Step({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="bg-void p-8">
      <div className="mb-5 flex size-10 items-center justify-center rounded-sm border border-hellfire/40 text-hellfire">
        {icon}
      </div>
      <h3 className="mb-3 font-grimoire text-[21px] font-medium leading-tight text-bone">
        {title}
      </h3>
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

/** The brand mark — the spawnd trident. Fits inside a square `size-N` box. */
function Trident({ className }: { className?: string }) {
  return (
    <span className={`relative inline-block ${className ?? ""}`}>
      <Image src="/trident.png" alt="" aria-hidden fill sizes="64px" className="object-contain" />
    </span>
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
