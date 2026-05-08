"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { agentActivityDetail, agentTitle } from "@/lib/agents";
import { type Agent, agents, type Host, hosts } from "@/lib/api";

export default function HomePage() {
  return (
    <AuthGate>
      <AppShell>
        <Dashboard />
      </AppShell>
    </AuthGate>
  );
}

function Dashboard() {
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list });
  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => agents.list(),
    refetchInterval: 5_000,
  });

  return (
    <div className="mx-auto w-full max-w-5xl p-4 @container/dash">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <Button asChild>
          <Link href="/agents">New agent</Link>
        </Button>
      </header>

      <section className="grid gap-4 @md/dash:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Hosts</CardTitle>
            <CardDescription>
              {hostsQ.isLoading
                ? "Loading..."
                : hostsQ.error
                  ? "Failed to load hosts"
                  : `${hostsQ.data?.length ?? 0} registered`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {(hostsQ.data ?? []).slice(0, 5).map((h: Host) => (
                <li key={h.id} className="flex items-center justify-between text-sm">
                  <span className="truncate">
                    <span
                      className={`mr-2 inline-block size-2 rounded-full ${
                        h.status === "online" ? "bg-green-500" : "bg-zinc-500"
                      }`}
                      aria-hidden
                    />
                    {h.name}
                  </span>
                  <span className="text-xs text-muted-foreground">{h.agent_count} agents</span>
                </li>
              ))}
              {!hostsQ.isLoading && (hostsQ.data?.length ?? 0) === 0 && (
                <li className="text-sm text-muted-foreground">
                  No hosts yet. Run <code>spawnd login</code> on a machine and approve it from{" "}
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
          <CardHeader>
            <CardTitle>Recent agents</CardTitle>
            <CardDescription>
              {agentsQ.isLoading
                ? "Loading..."
                : agentsQ.error
                  ? "Failed to load agents"
                  : `${agentsQ.data?.length ?? 0} total`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {(agentsQ.data ?? []).slice(0, 5).map((a: Agent) => (
                <li key={a.id} className="text-sm">
                  <Link
                    href={`/agents/${a.id}`}
                    className="flex items-center justify-between hover:underline"
                  >
                    <span className="truncate text-xs font-medium">{agentTitle(a)}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {agentActivityDetail(a)}
                    </span>
                  </Link>
                </li>
              ))}
              {!agentsQ.isLoading && (agentsQ.data?.length ?? 0) === 0 && (
                <li className="text-sm text-muted-foreground">No agents yet.</li>
              )}
            </ul>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
