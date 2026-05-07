"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError, type Host, hosts } from "@/lib/api";

export default function HostsPage() {
  return (
    <AuthGate>
      <AppShell>
        <HostsList />
      </AppShell>
    </AuthGate>
  );
}

function HostsList() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["hosts"], queryFn: hosts.list });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const removeM = useMutation({
    mutationFn: (id: string) => hosts.remove(id),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["hosts"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const renameM = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => hosts.rename(id, name),
    onSuccess: () => {
      setEditingId(null);
      setDraftName("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["hosts"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const startRename = (host: Host) => {
    setEditingId(host.id);
    setDraftName(host.name);
    setError(null);
  };

  const submitRename = (host: Host) => {
    const next = draftName.trim();
    if (!next) {
      setError("Host name is required.");
      return;
    }
    if (next === host.name) {
      setEditingId(null);
      setDraftName("");
      return;
    }
    renameM.mutate({ id: host.id, name: next });
  };

  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Hosts</h1>
        <Button asChild variant="outline">
          <Link href="/device">Approve a daemon</Link>
        </Button>
      </header>

      {q.isLoading && <p className="text-sm text-muted-foreground">Loading hosts...</p>}
      {q.error && (
        <p className="text-sm text-destructive" role="alert">
          Failed to load hosts: {String(q.error)}
        </p>
      )}
      {error && (
        <p className="mb-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {!q.isLoading && !q.error && (q.data?.length ?? 0) === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No hosts yet</CardTitle>
            <CardDescription>
              Install <code>spawnd</code> on a machine, run <code>spawnd login</code>, and approve
              the device code from{" "}
              <Link href="/device" className="underline">
                /device
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <ul className="space-y-2">
        {(q.data ?? []).map((h: Host) => (
          <li key={h.id}>
            <Card>
              <CardContent className="flex items-center justify-between p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span
                      className={`inline-block size-2 rounded-full ${
                        h.status === "online" ? "bg-green-500" : "bg-zinc-500"
                      }`}
                      aria-hidden
                    />
                    {editingId === h.id ? (
                      <Input
                        aria-label="Host name"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitRename(h);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="h-8"
                        disabled={renameM.isPending}
                      />
                    ) : (
                      <span className="truncate">{h.name}</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {h.os ?? "unknown"}/{h.arch ?? "unknown"} · v{h.version ?? "unknown"} ·{" "}
                    {h.agent_count} agents
                    {h.last_seen_at
                      ? ` · last seen ${new Date(h.last_seen_at).toLocaleString()}`
                      : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {editingId === h.id ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Save host name"
                        title="Save host name"
                        disabled={renameM.isPending}
                        onClick={() => submitRename(h)}
                      >
                        <Check className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Cancel rename"
                        title="Cancel rename"
                        disabled={renameM.isPending}
                        onClick={() => setEditingId(null)}
                      >
                        <X className="size-4" />
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Rename ${h.name}`}
                      title="Rename host"
                      onClick={() => startRename(h)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${h.name}`}
                    title="Remove host"
                    disabled={removeM.isPending}
                    onClick={() => {
                      if (confirm(`Remove host ${h.name}?`)) removeM.mutate(h.id);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
