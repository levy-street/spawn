import {
  ArrowRight,
  BadgeCheck,
  Download,
  GitBranch,
  MonitorDot,
  Server,
  TerminalSquare,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const FEATURES = [
  {
    title: "Run on your machines",
    copy: "Keep agent work close to the repos, GPUs, credentials, and files that already live on your hosts.",
    icon: Server,
  },
  {
    title: "Keep sessions up",
    copy: "The daemon supervises work directly, so agents can survive web refreshes, travel, and reconnects.",
    icon: Zap,
  },
  {
    title: "Approve every host",
    copy: "New daemons wait for approval before they can accept work from the shared control plane.",
    icon: BadgeCheck,
  },
];

const HOSTS = [
  { name: "dream", os: "linux/x86_64", status: "online", agents: 8 },
  { name: "nightmare", os: "linux/x86_64", status: "online", agents: 5 },
  { name: "alto", os: "windows/x86_64", status: "idle", agents: 1 },
];

export default function HomePage() {
  return (
    <main className="min-h-vv bg-background text-foreground">
      <section className="relative isolate min-h-[74svh] overflow-hidden border-b border-border pad-safe-x">
        <HeroScene />

        <header className="relative z-10 mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4">
          <Link href="/" className="text-lg font-semibold">
            spawn
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Button asChild variant="ghost" size="sm">
              <Link href="/download">Install</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/dash">
                Open app
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </nav>
        </header>

        <div className="relative z-10 mx-auto flex w-full max-w-6xl px-4 pb-12 pt-12 sm:pt-20 lg:pt-24">
          <div className="max-w-xl">
            <p className="mb-3 text-sm font-medium text-green-400">
              Remote agents for machines you control
            </p>
            <h1 className="text-5xl font-semibold leading-none sm:text-6xl lg:text-7xl">spawn</h1>
            <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground sm:text-lg">
              A small web control plane for starting, watching, and returning to coding agents
              running on your own hosts.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button asChild size="lg">
                <Link href="/signup">
                  Create account
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <Link href="/download">
                  <Download className="size-4" />
                  Install daemon
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-border bg-card/30 pad-safe-x">
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-10 md:grid-cols-[0.85fr_1.15fr] md:items-start">
          <div>
            <h2 className="text-2xl font-semibold">A fleet view for real development boxes.</h2>
            <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
              spawn keeps the browser lightweight and lets each daemon manage the local process,
              terminal, and workspace details where the work actually runs.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <article
                  key={feature.title}
                  className="rounded-md border border-border bg-background p-4"
                >
                  <Icon className="mb-3 size-5 text-green-400" aria-hidden />
                  <h3 className="text-sm font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{feature.copy}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="pad-safe-x">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-12 md:grid-cols-2 md:items-center">
          <div>
            <h2 className="text-2xl font-semibold">Built around host daemons.</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Install spawnd on macOS, Linux, or Windows through WSL, approve it once, then launch
              agents from the web UI without keeping a terminal tab open.
            </p>
          </div>
          <div className="rounded-md border border-border bg-card p-3">
            <div className="flex items-center gap-2 border-b border-border px-2 pb-3 text-sm text-muted-foreground">
              <TerminalSquare className="size-4" />
              install.sh
            </div>
            <pre className="overflow-x-auto whitespace-pre p-2 text-sm leading-6">
              <code>
                {"curl -fsSL https://spawnd.dev/install.sh | sh -s -- --server https://spawnd.dev"}
              </code>
            </pre>
          </div>
        </div>
      </section>
    </main>
  );
}

function HeroScene() {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden bg-background" aria-hidden="true">
      <div className="absolute bottom-[-12rem] left-4 right-4 h-[30rem] opacity-35 md:bottom-[-8rem] md:left-[42%] md:right-auto md:w-[44rem] md:opacity-65 lg:bottom-[-6rem] lg:left-[48%] lg:w-[50rem]">
        <div className="h-full rounded-md border border-border bg-card shadow-2xl">
          <div className="grid h-full grid-cols-[8rem_1fr] overflow-hidden">
            <div className="border-r border-border bg-background/80 p-3">
              <div className="mb-6 text-base font-semibold">spawn</div>
              <div className="space-y-2 text-xs text-muted-foreground">
                {["Dash", "Hosts", "Agents", "Install"].map((item, index) => (
                  <div
                    key={item}
                    className={`rounded-md px-3 py-2 ${index === 1 ? "bg-accent text-foreground" : ""}`}
                  >
                    {item}
                  </div>
                ))}
              </div>
            </div>
            <div className="min-w-0 p-4">
              <div className="mb-4">
                <div>
                  <div className="text-lg font-semibold">Hosts</div>
                  <div className="text-xs text-muted-foreground">3 approved daemons</div>
                </div>
              </div>
              <div className="grid gap-3">
                {HOSTS.map((host) => (
                  <div
                    key={host.name}
                    className="rounded-md border border-border bg-background p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <span
                            className={`size-2 rounded-full ${
                              host.status === "online" ? "bg-green-500" : "bg-sky-400"
                            }`}
                          />
                          <span>{host.name}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {host.os} - {host.agents} agents
                        </div>
                      </div>
                      <MonitorDot className="size-4 text-muted-foreground" />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-md border border-border bg-[#080808] p-3">
                <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <GitBranch className="size-4" />
                  dream - spawn
                </div>
                <div className="space-y-1 font-mono text-[11px] leading-5 text-green-300">
                  <div>$ git pull origin master</div>
                  <div>$ systemctl restart spawn-server spawn-web</div>
                  <div className="text-muted-foreground">service healthy - terminal attached</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
