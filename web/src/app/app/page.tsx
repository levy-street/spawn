"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Trident } from "@/components/icons/BrandMark";
import { AppShell } from "@/components/nav/AppShell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSpinner } from "@/components/ui/spinner";
import { NewWorkspaceMenu } from "@/components/workspace/new-workspace-menu";
import { WorkspaceSplit } from "@/components/workspace/workspace-split";
import { hosts, workspaces } from "@/lib/api";
import { useAuth, useAuthConfig } from "@/lib/auth";

/**
 * The door into the product: every route that means "take me to my work" —
 * signing in, finishing onboarding, deleting the workspace you were in, the
 * lander's Enter — lands here, and this decides where "my work" actually is
 * (verify email, connect a host, pick a workspace, or the last one you used).
 *
 * It is deliberately not `/`: the lander owns that, so the brand mark in the
 * app chrome can go back to the marketing site instead of bouncing straight
 * back in here. Signed out, there is nothing to resolve — go and sign in.
 */
export default function AppEntryPage() {
  const router = useRouter();
  const { user, loading: authLoading, error: authError } = useAuth();
  const { config, loading: configLoading, error: configError } = useAuthConfig();
  // The workspace this page just made, drawn here until the address bar
  // catches up. Every later workspace is created from inside one that is
  // already on screen, so it simply appears; the first one used to fall
  // through to the entry spinner below while the route changed, and a
  // full-page loader between picking a folder and seeing it was the one
  // creation that looked different from all the others.
  const [created, setCreated] = useState<{
    workspaceId: string;
    focusSessionId: string | null;
  } | null>(null);
  const hostsQ = useQuery({
    queryKey: ["hosts"],
    queryFn: hosts.list,
    enabled: Boolean(user),
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    enabled: Boolean(user),
  });

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
    if (!authLoading && !authError && !user) {
      router.replace("/login");
    }
  }, [authError, authLoading, router, user]);

  useEffect(() => {
    if (
      !user ||
      !config ||
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
      // Connecting a host is not optional: the product does nothing without
      // one, and there is no longer a way to say "later".
      router.replace("/onboarding?step=host");
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
    user,
    workspacesQ.error,
    workspacesQ.isLoading,
  ]);

  if (authLoading) return <PageSpinner label="Opening your workspace" />;
  if (authError) {
    return (
      <EmptyState
        title="Could not check your account"
        body={authError instanceof Error ? authError.message : String(authError)}
      />
    );
  }

  if (!user) return <PageSpinner label="Opening your workspace" />;

  if (configLoading || hostsQ.isLoading || workspacesQ.isLoading || verificationIncomplete) {
    return <PageSpinner label="Opening your workspace" />;
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

  if (created) {
    // The same tree /w/[id] renders, under the same shell, so the replace
    // that follows swaps the URL beneath a page that is already showing it.
    return (
      <AppShell mainClassName="overflow-hidden !pb-0">
        <WorkspaceSplit
          workspaceId={created.workspaceId}
          focusParam={created.focusSessionId}
          tabParam={null}
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
          action={<Button onClick={() => router.push("/legion")}>View hosts</Button>}
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
          body="Pick a folder on your host, then summon a wall of terminals into it."
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
                setCreated({ workspaceId, focusSessionId });
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

  return <PageSpinner label="Opening your workspace" />;
}
