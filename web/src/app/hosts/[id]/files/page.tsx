"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { FileExplorer } from "@/components/files/FileExplorer";
import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { hosts } from "@/lib/api";

export default function HostFilesPage() {
  return (
    <AuthGate>
      <AppShell>
        <Suspense fallback={null}>
          <HostFiles />
        </Suspense>
      </AppShell>
    </AuthGate>
  );
}

function HostFiles() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const searchParams = useSearchParams();
  const initialPath = searchParams?.get("path") ?? undefined;

  const hostQ = useQuery({
    queryKey: ["host", id],
    queryFn: () => hosts.get(id as string),
    enabled: !!id,
  });
  const host = hostQ.data;

  if (!id) return null;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col p-4 @md/shell:p-6">
      <header className="mb-3 flex shrink-0 items-center gap-2">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Back to host"
        >
          <Link href={`/hosts/${id}`}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight">
          Files{host ? ` · ${host.name}` : ""}
        </h1>
        {host &&
          (host.status === "online" ? (
            <Badge variant="success">online</Badge>
          ) : (
            <Badge variant="outline">offline</Badge>
          ))}
      </header>

      <FileExplorer
        hostId={id}
        rootLabel={host ? `${host.name} · ~` : "~"}
        initialPath={initialPath}
        className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border"
      />
    </div>
  );
}
