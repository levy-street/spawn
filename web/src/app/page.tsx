"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Flame, Plus, Server, Smartphone } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Trident, WORDMARK_CLASS } from "@/components/icons/BrandMark";
import { AppShell } from "@/components/nav/AppShell";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { NewWorkspaceMenu } from "@/components/workspace/new-workspace-menu";
import { hosts, workspaces } from "@/lib/api";
import { useAuth, useAuthConfig } from "@/lib/auth";

export default function HomePage() {
  const router = useRouter();
  const { user, loading: authLoading, error: authError } = useAuth();
  const { config, loading: configLoading, error: configError } = useAuthConfig();
  const [skippedHost, setSkippedHost] = useState<boolean | null>(null);
  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    enabled: Boolean(user),
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: workspaces.list,
    enabled: Boolean(user),
  });

  useEffect(() => {
    if (!user) {
      setSkippedHost(null);
      return;
    }
    setSkippedHost(window.localStorage.getItem("spawn.onboarding.skippedHost") === "true");
  }, [user]);

  const listedHosts = useMemo(() => hostsQ.data ?? [], [hostsQ.data]);
  const orderedWorkspaces = useMemo(
    () => [...(workspacesQ.data ?? [])].sort((a, b) => a.position - b.position),
    [workspacesQ.data],
  );
  const firstOnlineHost = listedHosts.find((host) => host.status === "online");
  const verificationIncomplete = Boolean(
    user && config?.email_verification_required && !user.email_verified_at,
  );

  useEffect(() => {
    if (
      !user ||
      !config ||
      skippedHost === null ||
      hostsQ.isLoading ||
      workspacesQ.isLoading ||
      hostsQ.error ||
      workspacesQ.error
    ) {
      return;
    }
    if (config.email_verification_required && !user.email_verified_at) {
      router.replace("/onboarding");
      return;
    }
    if (listedHosts.length === 0) {
      if (!skippedHost) router.replace("/onboarding?step=host");
      return;
    }
    if (orderedWorkspaces.length > 0) {
      const savedId = window.localStorage.getItem("spawn.workspaces.last");
      const target =
        orderedWorkspaces.find((workspace) => workspace.id === savedId) ?? orderedWorkspaces[0];
      if (target) {
        window.localStorage.setItem("spawn.workspaces.last", target.id);
        router.replace(`/w/${target.id}`);
      }
      return;
    }
  }, [
    config,
    hostsQ.error,
    hostsQ.isLoading,
    listedHosts,
    orderedWorkspaces,
    router,
    skippedHost,
    user,
    workspacesQ.error,
    workspacesQ.isLoading,
  ]);

  if (authLoading) return <HomeSpinner />;
  if (authError) {
    return (
      <EmptyState
        title="Could not check your account"
        body={authError instanceof Error ? authError.message : String(authError)}
      />
    );
  }

  if (!user) return <LandingPage />;

  if (
    configLoading ||
    skippedHost === null ||
    hostsQ.isLoading ||
    workspacesQ.isLoading ||
    verificationIncomplete
  ) {
    return <HomeSpinner />;
  }

  if (configError || hostsQ.error || workspacesQ.error) {
    const error = configError ?? hostsQ.error ?? workspacesQ.error;
    return (
      <EmptyState
        title="Could not load your workspace"
        body={error instanceof Error ? error.message : String(error)}
        action={
          <Button
            onClick={() => {
              void hostsQ.refetch();
              void workspacesQ.refetch();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }

  if (listedHosts.length === 0 && skippedHost) {
    return (
      <AppShell>
        <EmptyState
          className="min-h-[calc(var(--vv-height)-3rem)]"
          icon={<Server />}
          title="Connect a host to start a session"
          body="Install the daemon on a machine you control, then approve its pairing code."
          action={<Button onClick={() => openSettings("hosts")}>Connect a host</Button>}
        />
      </AppShell>
    );
  }

  if (listedHosts.length > 0 && orderedWorkspaces.length === 0 && !firstOnlineHost) {
    return (
      <AppShell>
        <EmptyState
          className="min-h-[calc(var(--vv-height)-3rem)]"
          icon={<Server />}
          title="Your host is offline"
          body="Bring a daemon online before creating the first workspace."
          action={<Button onClick={() => openSettings("hosts")}>View hosts</Button>}
        />
      </AppShell>
    );
  }

  if (orderedWorkspaces.length === 0) {
    // No silent auto-create: the first workspace is a deliberate act — pick
    // its folder (or replay a saved template) from the same menu the sidebar
    // button opens.
    return (
      <AppShell>
        <EmptyState
          className="min-h-[calc(var(--vv-height)-3rem)]"
          icon={<Trident className="size-8" />}
          title="Create your first workspace"
          body="A workspace is a grid of terminal panes rooted in one folder on your host. Shells, agents, and file explorers all open there."
          action={
            <NewWorkspaceMenu
              trigger={
                <Button size="lg">
                  <Plus className="size-4" aria-hidden />
                  New workspace
                </Button>
              }
              onCreated={({ workspaceId, focusSessionId }) => {
                window.localStorage.setItem("spawn.workspaces.last", workspaceId);
                router.replace(
                  focusSessionId
                    ? `/w/${workspaceId}?focus=${focusSessionId}`
                    : `/w/${workspaceId}`,
                );
              }}
            />
          }
        />
      </AppShell>
    );
  }

  return <HomeSpinner />;
}

function HomeSpinner() {
  return (
    <div className="flex min-h-vv items-center justify-center">
      <Spinner size={20} label="Opening your workspace" />
    </div>
  );
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
            <Trident className="size-6" />
            <span className={`${WORDMARK_CLASS} text-[19px] tracking-[0.3em] text-hellfire`}>
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
