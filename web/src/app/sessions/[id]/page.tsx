"use client";

import { useParams } from "next/navigation";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { SessionView } from "@/components/session/session-view";

export default function SessionPage() {
  const params = useParams<{ id: string }>();
  const sessionId = params?.id;
  return (
    <AuthGate>
      <AppShell hideMobileNav mainClassName="overflow-hidden !pb-0">
        {sessionId ? <SessionView key={sessionId} sessionId={sessionId} /> : null}
      </AppShell>
    </AuthGate>
  );
}
