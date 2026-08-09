"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronRight,
  Download,
  LogIn,
  Network,
  Server,
  ShieldCheck,
  SquareTerminal,
  Terminal,
} from "lucide-react";
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

const BACKDROP_CELLS = Array.from({ length: 140 }, (_, index) => `cell-${index}`);

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
    <main className="min-h-vv overflow-hidden bg-brand-bg text-foreground">
      <section className="relative min-h-[88svh] overflow-hidden border-border border-b">
        <TerminalBackdrop />

        <nav className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-5 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-3 text-lg font-semibold">
            <SquareTerminal className="size-7 shrink-0" aria-hidden />
            <span>spawn</span>
          </Link>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">
                <LogIn className="size-4" />
                Log in
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/signup">
                Sign up
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </nav>

        <div className="relative z-10 mx-auto flex min-h-[calc(88svh-5rem)] w-full max-w-7xl flex-col justify-center px-4 pb-16 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="mb-4 inline-flex items-center gap-2 rounded-md border border-brand-hairline bg-brand-panel/70 px-3 py-1 text-sm text-foreground/85">
              <Network className="size-4 text-sky-600 dark:text-sky-300" />
              Browser control for CLI coding agents
            </p>
            <h1 className="text-6xl font-semibold leading-none sm:text-7xl md:text-8xl">spawn</h1>
            <p className="mt-6 max-w-lg text-balance text-xl leading-8 text-foreground sm:text-2xl sm:leading-9">
              Run Codex, Claude, shell agents, and host tools across your laptop, workstations, and
              servers from one fast control plane.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link href="/signup">
                  <ArrowRight className="size-5" />
                  Start using spawn
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <Link href="/download">
                  <Download className="size-5" />
                  Install daemon
                </Link>
              </Button>
            </div>
            <div className="mt-8 max-w-2xl rounded-md border border-brand-hairline bg-brand-panel/80 p-3 font-mono text-xs text-foreground shadow-2xl shadow-black/10 dark:shadow-black/40 sm:text-sm">
              <span className="mr-2 text-emerald-600 dark:text-emerald-300">$</span>
              <code className="break-all">{installCommand}</code>
            </div>
          </div>
        </div>
      </section>

      <section
        id="install"
        className="border-border border-b bg-brand-panel px-4 py-12 sm:px-6 lg:px-8"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-8 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <p className="mb-3 text-sm font-medium text-amber-600 dark:text-amber-300">
              Host setup
            </p>
            <h2 className="text-3xl font-semibold leading-tight sm:text-4xl">
              One installer for macOS and Linux hosts.
            </h2>
            <p className="mt-4 max-w-xl text-base leading-7 text-foreground/85">
              The hosted script picks a prebuilt daemon for the host, falls back to a source build
              when needed, runs device-code login, and starts a user service where the OS supports
              it.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Capability icon={<Download className="size-5" />} title="Prebuilt first">
              Downloads a prebuilt daemon binary before attempting any Rust or git build path.
            </Capability>
            <Capability icon={<Server className="size-5" />} title="User services">
              Uses LaunchAgent on macOS and user systemd on Linux with a background fallback.
            </Capability>
            <Capability icon={<Terminal className="size-5" />} title="CLI native">
              Runs your existing agent CLIs in real terminals with durable host registration.
            </Capability>
            <Capability icon={<ShieldCheck className="size-5" />} title="Outbound only">
              Hosts dial the Spawn server over HTTPS/WSS, so no inbound SSH or agent ports are
              exposed.
            </Capability>
          </div>
        </div>
      </section>

      <section className="bg-brand-panel px-4 py-10 sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold">Bring a host online.</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Install the daemon, approve the device code, then start agents from the browser.
            </p>
          </div>
          <Button asChild size="lg">
            <Link href="/download">
              Download installer
              <ArrowRight className="size-5" />
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}

function TerminalBackdrop() {
  return (
    <div aria-hidden className="absolute inset-0">
      <div className="absolute inset-0 grid grid-cols-6 opacity-35 sm:grid-cols-10 lg:grid-cols-[repeat(14,minmax(0,1fr))]">
        {BACKDROP_CELLS.map((cell) => (
          <div key={cell} className="min-h-14 border-brand-hairline border-r border-b" />
        ))}
      </div>
      <div className="absolute top-[14%] right-[-8rem] hidden w-[56rem] rotate-[-3deg] rounded-md border border-brand-hairline bg-brand-panel/80 p-4 shadow-2xl shadow-black/15 dark:shadow-black/70 md:block">
        <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-3 rounded-full bg-rose-400" />
          <span className="size-3 rounded-full bg-amber-600 dark:bg-amber-300" />
          <span className="size-3 rounded-full bg-emerald-400" />
          <span className="ml-3">spawn / hosts / agents</span>
        </div>
        <div className="grid gap-3">
          <BackdropLine
            accent="bg-emerald-600 dark:bg-emerald-300"
            text="dream online - 8 agents - codex ready"
          />
          <BackdropLine
            accent="bg-sky-600 dark:bg-sky-300"
            text="nightmare online - gpu queue - nvtop active"
          />
          <BackdropLine
            accent="bg-amber-600 dark:bg-amber-300"
            text="macbook online - local review agent - skills granted"
          />
          <div className="mt-2 h-40 rounded-md border border-brand-hairline bg-brand-well p-4 font-mono text-sm text-foreground/85">
            <p>
              <span className="text-emerald-600 dark:text-emerald-300">$</span> spawn agent create
              --preset codex --host dream
            </p>
            <p className="mt-3 text-muted-foreground">routing terminal frames over WSS...</p>
            <p className="mt-3 text-sky-600 dark:text-sky-300">agent ready - ~/projects/spawn</p>
          </div>
        </div>
      </div>
      <div className="absolute bottom-10 left-4 hidden w-[22rem] rounded-md border border-brand-hairline bg-brand-panel/80 p-4 shadow-xl shadow-black/15 dark:shadow-black/60 sm:left-8 sm:block">
        <div className="font-mono text-xs leading-6 text-foreground/85">
          <p className="text-emerald-600 dark:text-emerald-300">spawnd 0.1.0</p>
          <p>host registered</p>
          <p className="text-sky-600 dark:text-sky-300">terminal attached</p>
          <p className="text-amber-600 dark:text-amber-300">skills granted</p>
        </div>
      </div>
    </div>
  );
}

function BackdropLine({ accent, text }: { accent: string; text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-brand-hairline bg-foreground/[0.03] px-3 py-2 font-mono text-sm text-foreground/85">
      <span className={`size-2 rounded-full ${accent}`} />
      <span>{text}</span>
    </div>
  );
}

function Capability({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-brand-hairline bg-brand-panel/50 p-4">
      <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-white text-black">
        {icon}
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{children}</p>
    </div>
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
          <Link href="/agents/new">New agent</Link>
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
                    : `${hostsQ.data?.length ?? 0} registered`}
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
                  No hosts yet. Run <code>spawnd login</code> on a machine and approve it at{" "}
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
                    : `${agentsQ.data?.length ?? 0} total`}
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
                <li className="px-4 py-3 text-sm text-muted-foreground">No agents yet.</li>
              )}
            </ul>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
