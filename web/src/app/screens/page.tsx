"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelsTopLeft, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, screens } from "@/lib/api";

/**
 * /screens is a switchboard: with screens it forwards to the last-used one
 * (each screen renders the full tab strip); with none it offers the first.
 */
export default function ScreensPage() {
  return (
    <AuthGate>
      <AppShell>
        <ScreensGate />
      </AppShell>
    </AuthGate>
  );
}

function ScreensGate() {
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["screens"], queryFn: screens.list });

  const createM = useMutation({
    mutationFn: () => screens.create({ name: "Screen 1", layout: { root: null } }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["screens"] });
      router.replace(`/screens/${created.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  useEffect(() => {
    if (!q.data || q.data.length === 0) return;
    const last = window.localStorage.getItem("spawn.screens.last");
    const target = q.data.find((screen) => screen.id === last) ?? q.data[0];
    router.replace(`/screens/${target.id}`);
  }, [q.data, router]);

  if (q.isLoading || (q.data?.length ?? 0) > 0) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <Skeleton className="h-10 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="grid min-h-[70dvh] place-items-center p-4">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <span className="grid size-12 place-items-center rounded-2xl border border-border bg-muted/50 text-muted-foreground">
          <PanelsTopLeft className="size-6" aria-hidden />
        </span>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">No screens yet</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A screen arranges several agent terminals in resizable split panes, saved under a name.
            Create one and drag agents in from the sidebar.
          </p>
        </div>
        {(error || q.error) && (
          <p className="text-sm text-destructive" role="alert">
            {error ?? String(q.error)}
          </p>
        )}
        <Button disabled={createM.isPending} onClick={() => createM.mutate()}>
          <Plus className="size-4" />
          Add screen
        </Button>
      </div>
    </div>
  );
}
