"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { NewAgentForm } from "@/components/agents/NewAgentForm";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";

export default function NewAgentPage() {
  return (
    <AuthGate>
      <AppShell>
        <div className="mx-auto w-full max-w-2xl p-4 @md/shell:p-6">
          <header className="mb-5 flex items-center gap-2">
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Back to agents"
            >
              <Link href="/agents">
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">New agent</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Pick a host and an agent, choose where it runs.
              </p>
            </div>
          </header>
          <Suspense fallback={null}>
            <NewAgentFormWithParams />
          </Suspense>
        </div>
      </AppShell>
    </AuthGate>
  );
}

function NewAgentFormWithParams() {
  const searchParams = useSearchParams();
  return (
    <NewAgentForm
      initialHostId={searchParams?.get("host") ?? undefined}
      intoScreenId={searchParams?.get("screen") ?? undefined}
    />
  );
}
