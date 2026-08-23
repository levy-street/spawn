"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth/AuthGate";
import { AppShell } from "@/components/nav/AppShell";
import { WorkspaceSplit } from "@/components/workspace/workspace-split";

export default function WorkspacePage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params?.id;
  return (
    <AuthGate>
      <AppShell mainClassName="overflow-hidden !pb-0">
        <Suspense fallback={null}>
          {workspaceId ? <RoutedWorkspace workspaceId={workspaceId} /> : null}
        </Suspense>
      </AppShell>
    </AuthGate>
  );
}

/**
 * The search params, read once for the window. They describe the workspace the
 * URL is about, so they reach the primary half only; `WorkspaceSplit` is what
 * decides how many halves there are.
 *
 * Its own component so the read stays under the Suspense boundary above —
 * `useSearchParams` opts everything above it out of static rendering, and that
 * would otherwise be the whole shell.
 */
function RoutedWorkspace({ workspaceId }: { workspaceId: string }) {
  const searchParams = useSearchParams();
  return (
    <WorkspaceSplit
      workspaceId={workspaceId}
      focusParam={searchParams.get("focus")}
      tabParam={searchParams.get("tab")}
    />
  );
}
