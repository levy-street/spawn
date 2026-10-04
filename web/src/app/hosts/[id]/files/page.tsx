"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { HostFilesBrowser } from "@/components/files/host-files-browser";
import { AppShell } from "@/components/nav/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { hosts } from "@/lib/api";

export default function HostFilesPage() {
  return (
    <AuthGate>
      {/* The browser scrolls its own list, so the page is exactly one screen tall. */}
      <AppShell mainClassName="overflow-hidden !pb-0">
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

  const hostQ = useQuery({
    queryKey: ["host", id],
    queryFn: () => hosts.get(id as string),
    enabled: !!id,
  });
  const host = hostQ.data;

  if (!id) return null;

  return (
    <div className="flex h-[calc(var(--vv-height)-3rem)] w-full flex-col p-2 @md/shell:h-[calc(var(--vv-height)-2*var(--content-inset))] @md/shell:p-4">
      <header className="mb-2 flex shrink-0 items-center gap-2">
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

      {/* Where it opens — never from or into the URL — is the browser's own business. */}
      <HostFilesBrowser
        key={id}
        hostId={id}
        className="overflow-hidden rounded-xl border border-border"
      />
    </div>
  );
}
