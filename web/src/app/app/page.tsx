"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { Trident } from "@/components/icons/BrandMark";
import { AppShell } from "@/components/nav/AppShell";
import { useDeviceTrustMap } from "@/components/trust/device-endorsement";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { NewWorkspaceMenu } from "@/components/workspace/new-workspace-menu";
import { browserDevices, hosts, trust, workspaces } from "@/lib/api";
import { useAuth, useAuthConfig } from "@/lib/auth";
import { useBrowserDeviceRegistration } from "@/lib/browser-device-registration";
import { computeTrustRoster } from "@/lib/trust-roster";

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
  const registration = useBrowserDeviceRegistration(user?.id);
  const devicesQ = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled: Boolean(user),
  });
  const edgesQ = useQuery({
    queryKey: ["account-endorsements"],
    queryFn: trust.accountEndorsements,
    enabled: Boolean(user),
  });
  const trustMap = useDeviceTrustMap(Boolean(user));

  const listedHosts = useMemo(() => hostsQ.data ?? [], [hostsQ.data]);
  const orderedWorkspaces = useMemo(
    () => [...(workspacesQ.data ?? [])].sort((a, b) => a.position - b.position),
    [workspacesQ.data],
  );
  const firstOnlineHost = listedHosts.find((host) => host.status === "online");
  const verificationIncomplete = Boolean(
    user && config?.email_verification_required && !user.email_verified_at,
  );
  const currentPublicKey = registration.data?.publicKey ?? null;
  const currentDevice =
    (devicesQ.data ?? []).find((device) => device.public_key === currentPublicKey) ??
    (registration.data?.status === "ready" ? registration.data.device : undefined);
  const roster = computeTrustRoster(
    devicesQ.data ?? [],
    edgesQ.data ?? [],
    trustMap.pinnedDeviceIds,
  );
  const approvalCheckReady =
    registration.isError ||
    registration.data?.status === "cleanup_pending" ||
    registration.data?.status === "revoked" ||
    devicesQ.isError ||
    edgesQ.isError ||
    (registration.data?.status === "ready" &&
      devicesQ.data !== undefined &&
      edgesQ.data !== undefined &&
      trustMap.ready);
  const currentDeviceTrusted =
    currentDevice !== undefined &&
    ((roster.get(currentDevice.id)?.chainTrusted ?? false) ||
      trustMap.trustedHostIdsFor(currentDevice.id).length > 0);
  const currentDeviceBlocked =
    registration.isError ||
    registration.data?.status === "cleanup_pending" ||
    registration.data?.status === "revoked" ||
    devicesQ.isError ||
    edgesQ.isError ||
    (trustMap.keyedHosts.length > 0 && currentDevice !== undefined && !currentDeviceTrusted);

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
      workspacesQ.error ||
      !approvalCheckReady
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
    if (currentDeviceBlocked) {
      // `/app` must remain a safe door: an unapproved device can manage its
      // machines and open Access from the shell, instead of being bounced
      // straight into a terminal pane the daemon will refuse.
      router.replace("/legion");
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
    approvalCheckReady,
    currentDeviceBlocked,
    hostsQ.error,
    hostsQ.isLoading,
    listedHosts,
    orderedWorkspaces,
    router,
    user,
    workspacesQ.error,
    workspacesQ.isLoading,
  ]);

  if (authLoading) return <AppEntrySpinner />;
  if (authError) {
    return (
      <EmptyState
        title="Could not check your account"
        body={authError instanceof Error ? authError.message : String(authError)}
      />
    );
  }

  if (!user) return <AppEntrySpinner />;

  if (
    configLoading ||
    hostsQ.isLoading ||
    workspacesQ.isLoading ||
    !approvalCheckReady ||
    verificationIncomplete
  ) {
    return <AppEntrySpinner />;
  }

  if (configError || hostsQ.error || workspacesQ.error || devicesQ.error || edgesQ.error) {
    const error =
      configError ?? hostsQ.error ?? workspacesQ.error ?? devicesQ.error ?? edgesQ.error;
    return (
      <EmptyState
        title="Could not load your workspace"
        body={error instanceof Error ? error.message : String(error)}
        action={
          <Button
            onClick={() => {
              void hostsQ.refetch();
              void workspacesQ.refetch();
              void devicesQ.refetch();
              void edgesQ.refetch();
            }}
          >
            Try again
          </Button>
        }
      />
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

  return <AppEntrySpinner />;
}

function AppEntrySpinner() {
  return (
    <div className="flex min-h-vv items-center justify-center">
      <Spinner size={20} label="Opening your workspace" />
    </div>
  );
}
