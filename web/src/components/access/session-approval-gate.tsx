"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, MonitorCog, RefreshCw, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { useDeviceTrustMap } from "@/components/trust/device-endorsement";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useDesktopShell } from "@/hooks/useDesktopShell";
import { browserDevices, trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBrowserDeviceRegistration } from "@/lib/browser-device-registration";
import { isAgentSessionPath } from "@/lib/session-approval";
import { usePasskeyTrust } from "@/lib/trust-passkeys";
import { computeTrustRoster, hostsTrustingDevice } from "@/lib/trust-roster";

const WAIT_GUIDANCE_AFTER_MS = 2 * 60_000;
const APPROVAL_REKNOCK_MS = 10 * 60_000;

interface SessionApprovalGateState {
  readonly deviceName: string;
  readonly hasApprover: boolean;
  readonly waitingTooLong: boolean;
  readonly requesting: boolean;
  readonly requestFailed: boolean;
  readonly hostNames: readonly string[];
  readonly inDesktopShell: boolean;
  readonly passkey: ReturnType<typeof usePasskeyTrust>;
  readonly askAgain: () => void;
}

const SessionApprovalGateContext = createContext<SessionApprovalGateState | null>(null);

/**
 * Advisory approval state for terminal panes.
 *
 * The daemon remains the admission boundary. This provider only decides when
 * ConnectingOverlay should replace its ordinary blocked state with recovery
 * guidance. Keeping the state here makes one knock serve every pane in a
 * workspace, while the card itself stays inside each blocked pane and leaves
 * the sidebar, Settings, and the rest of the shell usable.
 */
export function SessionApprovalGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const inDesktopShell = useDesktopShell();
  const sessionOpen = isAgentSessionPath(pathname);
  const enabled = user !== null && sessionOpen;

  const registration = useBrowserDeviceRegistration(user?.id);
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled,
    refetchInterval: 4000,
  });
  const edges = useQuery({
    queryKey: ["account-endorsements"],
    queryFn: trust.accountEndorsements,
    enabled,
    refetchInterval: 4000,
  });
  const trustMap = useDeviceTrustMap(enabled);
  const passkey = usePasskeyTrust();

  const currentPublicKey = registration.data?.publicKey ?? null;
  const currentDevice =
    (devices.data ?? []).find((device) => device.public_key === currentPublicKey) ??
    (registration.data?.status === "ready" ? registration.data.device : undefined);
  const currentDeviceId = currentDevice?.id;
  const currentDevicePublicKey = currentDevice?.public_key;
  const roster = computeTrustRoster(devices.data ?? [], edges.data ?? [], trustMap.pinnedDeviceIds);
  const ready =
    registration.data?.status === "ready" &&
    trustMap.ready &&
    devices.data !== undefined &&
    edges.data !== undefined;
  const currentTrusted =
    currentDevice !== undefined &&
    ((roster.get(currentDevice.id)?.chainTrusted ?? false) ||
      trustMap.trustedHostIdsFor(currentDevice.id).length > 0);
  const show =
    sessionOpen &&
    ready &&
    trustMap.keyedHosts.length > 0 &&
    currentDevice !== undefined &&
    !currentTrusted;

  const pairings = useQuery({
    queryKey: ["device-pairings", currentDevice?.id ?? null],
    queryFn: () => trust.listPairings(currentDevice?.id ?? ""),
    refetchInterval: 1500,
    enabled: show && currentDevice !== undefined,
  });
  const ceremonyLive = (pairings.data ?? []).length > 0;

  const request = useMutation({
    mutationFn: async (device: { id: string; public_key: string }) => {
      await Promise.all([
        browserDevices.requestApproval(device.id, device.public_key),
        trust.requestDeviceApproval(device.id),
      ]);
    },
  });
  const [waitCycle, setWaitCycle] = useState(0);
  const [waitingTooLong, setWaitingTooLong] = useState(false);

  // Knock immediately, then refresh the request well inside the server's
  // 30-minute TTL for as long as somebody is actively waiting on this pane.
  useEffect(() => {
    if (!show || currentDeviceId === undefined || currentDevicePublicKey === undefined) return;
    const knock = () => request.mutate({ id: currentDeviceId, public_key: currentDevicePublicKey });
    knock();
    const interval = window.setInterval(knock, APPROVAL_REKNOCK_MS);
    return () => window.clearInterval(interval);
  }, [currentDeviceId, currentDevicePublicKey, request.mutate, show]);

  useEffect(() => {
    // Both values restart the guidance clock without changing its duration.
    void currentDeviceId;
    void waitCycle;
    if (!show) {
      setWaitingTooLong(false);
      return;
    }
    setWaitingTooLong(false);
    const timer = window.setTimeout(() => setWaitingTooLong(true), WAIT_GUIDANCE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [currentDeviceId, show, waitCycle]);

  const hasApprover = useMemo(() => {
    if (!show || currentDevice === undefined) return false;
    return (devices.data ?? []).some(
      (device) =>
        device.id !== currentDevice.id &&
        device.revoked_at === null &&
        hostsTrustingDevice(
          device.id,
          trustMap.keyedHosts,
          trustMap.pinsByHost,
          devices.data ?? [],
          edges.data ?? [],
        ).length > 0,
    );
  }, [currentDevice, devices.data, edges.data, show, trustMap.keyedHosts, trustMap.pinsByHost]);

  const state = useMemo<SessionApprovalGateState | null>(() => {
    if (!show || ceremonyLive || currentDevice === undefined) return null;
    return {
      deviceName: currentDevice.label ?? "This device",
      hasApprover,
      waitingTooLong,
      requesting: request.isPending,
      requestFailed: request.isError,
      hostNames: trustMap.keyedHosts.map((host) => host.name),
      inDesktopShell,
      passkey,
      askAgain: () => {
        setWaitCycle((cycle) => cycle + 1);
        request.mutate({ id: currentDevice.id, public_key: currentDevice.public_key });
      },
    };
  }, [
    ceremonyLive,
    currentDevice,
    hasApprover,
    inDesktopShell,
    passkey,
    request,
    show,
    trustMap.keyedHosts,
    waitingTooLong,
  ]);

  return (
    <SessionApprovalGateContext.Provider value={state}>
      {children}
    </SessionApprovalGateContext.Provider>
  );
}

export function useSessionApprovalGate(): SessionApprovalGateState | null {
  return useContext(SessionApprovalGateContext);
}

/** The actionable blocked state rendered by ConnectingOverlay. */
export function SessionApprovalGateCard({ state }: { state: SessionApprovalGateState }) {
  const deviceLabel = state.deviceName === "This device" ? "this device" : `“${state.deviceName}”`;
  const recovery = !state.hasApprover || state.waitingTooLong || state.requestFailed;
  const hostLabel =
    state.hostNames.length === 1
      ? state.hostNames[0]
      : state.hostNames.length > 1
        ? `${state.hostNames[0]} or another host`
        : "your host";

  return (
    <section
      data-testid="session-approval-gate"
      aria-label="Device approval required"
      className="pointer-events-auto max-h-full w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card p-5 text-left shadow-lg"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning">
          {state.hasApprover ? (
            <KeyRound className="size-4" aria-hidden />
          ) : (
            <ShieldAlert className="size-4" aria-hidden />
          )}
        </span>
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-foreground">
            {state.hasApprover ? "Approve this device" : "No trusted device can approve this one"}
          </h2>
          <p className="text-xs leading-5 text-muted-foreground">
            {state.hasApprover
              ? `Approve ${deviceLabel} from another device signed in to SPAWN D.`
              : `${deviceLabel[0]?.toUpperCase()}${deviceLabel.slice(1)} is signed in, but none of your other devices can grant host access.`}
          </p>
        </div>
      </div>

      {state.hasApprover && !state.waitingTooLong && !state.requestFailed ? (
        <div className="mt-4 space-y-3">
          <div
            className="flex items-start gap-2.5 text-xs leading-5 text-muted-foreground"
            role="status"
          >
            <Spinner size={16} label="Waiting for device approval" className="mt-0.5 shrink-0" />
            <p>
              On the trusted device, choose{" "}
              <span className="font-medium text-foreground">Enter its number</span>. A 4-digit
              number will appear here; type it there to finish the check.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          {state.requestFailed && (
            <p className="text-xs leading-5 text-destructive" role="alert">
              SPAWN D could not reach your other devices. Ask again, or use a recovery option below.
            </p>
          )}
          {state.waitingTooLong && state.hasApprover && (
            <p className="text-xs leading-5 text-foreground">
              No approval has arrived yet. You can ask again or recover access without waiting.
            </p>
          )}
          <div className="flex gap-2 text-xs leading-5 text-muted-foreground">
            <MonitorCog className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              On {hostLabel}, run <code className="font-mono text-foreground">spawnd</code>, open{" "}
              <span className="font-medium text-foreground">Manage this machine</span>, then choose{" "}
              <span className="font-medium text-foreground">Approve</span>.
            </p>
          </div>
          {state.inDesktopShell && (
            <p className="text-xs leading-5 text-muted-foreground">
              In the desktop app, open the SPAWN D tray menu and choose{" "}
              <span className="font-medium text-foreground">Repair…</span> to repair this
              machine&apos;s setup.
            </p>
          )}
        </div>
      )}

      {state.passkey.status !== null && (
        <p className="mt-3 text-xs font-medium text-foreground" role="status">
          {state.passkey.status}
        </p>
      )}
      {state.passkey.error !== null && (
        <p className="mt-3 text-xs leading-5 text-destructive" role="alert">
          {state.passkey.error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {state.passkey.hasBundle && (
          <Button
            size="sm"
            disabled={!state.passkey.supported || state.passkey.busy}
            onClick={() => state.passkey.unlock.mutate()}
            data-testid="session-gate-passkey"
          >
            {state.passkey.unlock.isPending ? "Checking…" : "Use passkey"}
          </Button>
        )}
        {recovery && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={state.requesting}
            onClick={state.askAgain}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Ask again
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={() => openSettings("access")}>
          Open Access
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href="/legion">View machines</Link>
        </Button>
      </div>
    </section>
  );
}
