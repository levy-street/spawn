"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Laptop, MonitorCog, MoreHorizontal, Plus, Smartphone, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { requestApproval } from "@/components/access/ceremony-store";
import { type OrphanVM, RemoveDeviceDialog } from "@/components/access/remove-device";
import { closeSettings } from "@/components/settings/settings-dialog-store";
import { EndorseDevicePanel, useDeviceTrustMap } from "@/components/trust/device-endorsement";
import { IntroductionPanel } from "@/components/trust/introduction-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AccessPinDetail, deriveAccessView } from "@/lib/access-view";
import { type BrowserDevice, browserDevices, hosts as hostsApi, trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { loadBrowserDeviceIdentity } from "@/lib/browser-device-identity";
import {
  allowExplicitBrowserIdentityReplacement,
  type BrowserDeviceRegistrationState,
  beginBrowserDeviceLocalCleanup,
  browserDeviceRegistrationQueryKey,
  finishBrowserDeviceLocalCleanup,
  useBrowserDeviceRegistration,
} from "@/lib/browser-device-registration";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";
import { usePasskeyTrust } from "@/lib/trust-passkeys";
import { computeTrustRoster, hostsSolelyTrustedBy } from "@/lib/trust-roster";

const NUDGE_DISMISSED_KEY = (accountId: string) => `spawn:access:passkey-nudge:${accountId}`;

/**
 * Access — the one trust destination (docs/TRUST_UX.md). Two nouns (device,
 * host), three verbs (approve, possess, remove), one artifact (the number).
 * A device appears here the moment it signs in; approval is the transition,
 * not the insertion. Row provenance and the history lines are the audit
 * surface (R4). Everything mesh-vocabulary lives behind Advanced.
 */
export function AccessPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const registration = useBrowserDeviceRegistration(user?.id);
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled: user !== null,
    // Poll while this panel is open so a device signing in on another screen
    // shows up here to approve, and a removal reflects, without a reload.
    refetchInterval: 4000,
  });
  const localIdentity = useQuery({
    queryKey: ["browser-device-local-identity", user?.id],
    queryFn: () => loadBrowserDeviceIdentity(user!.id),
    enabled: user !== null,
    retry: false,
  });
  const hostList = useQuery({
    queryKey: ["trust", "hosts"],
    queryFn: () => hostsApi.list(),
    enabled: user !== null,
    refetchInterval: 15_000,
  });
  const accountEdges = useQuery({
    queryKey: ["account-endorsements"],
    queryFn: trust.accountEndorsements,
    enabled: user !== null,
    refetchInterval: 15_000,
  });
  const trustMap = useDeviceTrustMap(user !== null);
  const passkey = usePasskeyTrust();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (registration.data?.status === "ready") {
      void qc.invalidateQueries({ queryKey: ["browser-devices"] });
      // The local-identity read can resolve to null moments before registration
      // finishes writing it; refetch so anything gated on the identity (e.g.
      // the approve ceremony) appears without a manual reload.
      void qc.invalidateQueries({ queryKey: ["browser-device-local-identity", user?.id] });
    }
  }, [qc, registration.data?.status, user?.id]);

  const currentPublicKey =
    registration.data?.publicKey ?? localIdentity.data?.publicKeyWire ?? null;
  const currentDevice =
    (devices.data ?? []).find((device) => device.public_key === currentPublicKey) ??
    (registration.data?.status === "ready" ? registration.data.device : undefined);

  // Pin provenance per host — who possessed it, and which pins are direct.
  // Display only; failures leave a host without provenance, nothing more.
  const keyedHostIds = (hostList.data ?? []).map((h) => h.id);
  const pinDetails = useQuery({
    queryKey: ["trust", "host-pin-details", keyedHostIds.join(",")],
    queryFn: async () => {
      const entries = await Promise.all(
        keyedHostIds.map(
          async (hostId) => [hostId, await trust.hostPinDetails(hostId).catch(() => [])] as const,
        ),
      );
      return new Map<string, AccessPinDetail[]>(entries);
    },
    enabled: user !== null && keyedHostIds.length > 0,
    refetchInterval: 30_000,
  });

  // Derive each device's fingerprint locally from its key rather than trusting
  // the server's `fingerprint` field: it is what the legacy approve ceremony
  // and Advanced show, so a hostile server must not mislabel devices.
  const deviceFingerprints = useQuery({
    queryKey: [
      "browser-device-fingerprints",
      (devices.data ?? []).map((device) => device.public_key).join(","),
    ],
    queryFn: async () => {
      const entries = await Promise.all(
        (devices.data ?? []).map(
          async (device) =>
            [device.id, await ed25519PublicKeyFingerprint(device.public_key)] as const,
        ),
      );
      return new Map(entries);
    },
    enabled: (devices.data?.length ?? 0) > 0,
  });

  // Advisory reachability (R4): what the roster shows, never what admits.
  const roster = computeTrustRoster(
    devices.data ?? [],
    accountEdges.data ?? [],
    trustMap.pinnedDeviceIds,
  );

  // The list is the single source of rows; when the current device is known
  // from registration but the fetch has not caught up yet, synthesize its row
  // so "this device" always has a home.
  const listed = devices.data ?? [];
  const allDevices: BrowserDevice[] =
    currentDevice && !listed.some((device) => device.id === currentDevice.id)
      ? [currentDevice as BrowserDevice, ...listed]
      : listed;

  const view = deriveAccessView(
    {
      devices: allDevices,
      edges: accountEdges.data ?? [],
      hosts: hostList.data ?? [],
      pinDetails: pinDetails.data ?? new Map(),
      passkeys: passkey.passkeys.data ?? [],
      currentDeviceId: currentDevice?.id ?? null,
    },
    new Date(),
  );
  // Refine waiting with the roster's reachability: an edge from a severed
  // chain must not read as approved, and chain-trusted rows must never show
  // the waiting pill. The first device is exempt — there is nothing that
  // could have approved it.
  const trustDataReady = trustMap.ready && accountEdges.data !== undefined;
  const deviceRows = view.devices.map((vm) => {
    if (!trustDataReady || vm.provenance === "First device") return vm;
    const trusted =
      (roster.get(vm.id)?.chainTrusted ?? false) || trustMap.trustedHostIdsFor(vm.id).length > 0;
    if (vm.waiting && trusted) return { ...vm, waiting: undefined };
    if (!vm.waiting && !trusted) return { ...vm, waiting: true };
    return vm;
  });

  const currentTrusted =
    currentDevice !== undefined &&
    ((roster.get(currentDevice.id)?.chainTrusted ?? false) ||
      trustMap.trustedHostIdsFor(currentDevice.id).length > 0);
  const showWaitingCallout =
    currentDevice !== undefined &&
    trustDataReady &&
    trustMap.keyedHosts.length > 0 &&
    !currentTrusted &&
    registration.data?.status === "ready";

  const setRegistrationState = (state: BrowserDeviceRegistrationState) => {
    if (!user) return;
    qc.setQueryData(browserDeviceRegistrationQueryKey(user.id), state);
  };

  const revoke = useMutation({
    mutationFn: async (device: BrowserDevice) => {
      if (!user) throw new Error("not authenticated");
      const revoked = await browserDevices.revoke(
        device.id,
        device.public_key,
        // Attribution (R4): name the device that asked for this removal.
        currentDevice?.id ?? null,
      );
      if (
        revoked.id !== device.id ||
        revoked.public_key !== device.public_key ||
        revoked.revoked_at === null
      ) {
        throw new Error("The removal did not confirm the expected device key");
      }
      if (device.public_key !== currentPublicKey) return revoked;

      // Disable identity-dependent actions immediately after the server
      // confirms revocation, even if durable local cleanup fails below.
      setRegistrationState({ status: "cleanup_pending", publicKey: device.public_key });
      try {
        const localStatus = await beginBrowserDeviceLocalCleanup(user.id, device.public_key);
        setRegistrationState({ status: localStatus, publicKey: device.public_key });
        if (localStatus === "cleanup_pending") {
          await finishBrowserDeviceLocalCleanup(user.id, device.public_key);
          setRegistrationState({ status: "revoked", publicKey: device.public_key });
          qc.setQueryData(["browser-device-local-identity", user.id], null);
        }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`The device was removed, but local key cleanup failed: ${detail}`);
      }
      return revoked;
    },
    onSuccess: () => {
      setError(null);
      setRemoveTarget(null);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["browser-devices"] }),
  });

  const retryCleanup = async (expectedPublicKey: string) => {
    if (!user) return;
    setError(null);
    try {
      await finishBrowserDeviceLocalCleanup(user.id, expectedPublicKey);
      setRegistrationState({ status: "revoked", publicKey: expectedPublicKey });
      qc.setQueryData(["browser-device-local-identity", user.id], null);
    } catch (cause) {
      setError(`Local key cleanup still failed: ${cause instanceof Error ? cause.message : cause}`);
    }
  };

  /**
   * One explicit action for "this browser was removed, get me going again":
   * clean up the dead local key (idempotent) and authorize minting a fresh
   * identity. Still a single deliberate user click — a removed browser never
   * silently re-mints itself.
   */
  const startFresh = async (publicKey: string) => {
    if (!user) return;
    setError(null);
    try {
      const status = await beginBrowserDeviceLocalCleanup(user.id, publicKey);
      setRegistrationState({ status, publicKey });
      if (status === "cleanup_pending") {
        await finishBrowserDeviceLocalCleanup(user.id, publicKey);
      }
      setRegistrationState({ status: "revoked", publicKey });
      qc.setQueryData(["browser-device-local-identity", user.id], null);
      allowExplicitBrowserIdentityReplacement(user.id, publicKey);
      void qc.invalidateQueries({ queryKey: browserDeviceRegistrationQueryKey(user.id) });
      void qc.invalidateQueries({ queryKey: ["browser-device-local-identity", user.id] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const rename = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string | null }) =>
      browserDevices.rename(id, label),
    onSuccess: () => {
      setRenameTarget(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["browser-devices"] });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
  });

  // Forgets tombstones only: removal stays permanent (live pins were already
  // severed, and a hard-deleted endorser fails closed daemon-side).
  const prune = useMutation({
    mutationFn: () => browserDevices.prune(),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["browser-devices"] });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
  });

  // Dialog state.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<BrowserDevice | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [removeTarget, setRemoveTarget] = useState<BrowserDevice | null>(null);
  const [newDeviceHint, setNewDeviceHint] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [legacyApproveId, setLegacyApproveId] = useState<string | null>(null);
  const [legacyNote, setLegacyNote] = useState<string | null>(null);
  const [nudgeDismissed, setNudgeDismissed] = useState(true);
  useEffect(() => {
    if (!user) return;
    setNudgeDismissed(window.localStorage.getItem(NUDGE_DISMISSED_KEY(user.id)) === "1");
  }, [user]);

  const deviceById = (id: string) => allDevices.find((d) => d.id === id);
  const removeOrphans: OrphanVM[] =
    removeTarget === null
      ? []
      : hostsSolelyTrustedBy(removeTarget.id, trustMap.pinsByHost).map((hostId) => {
          const host = trustMap.hostsById.get(hostId);
          return { name: host?.name ?? hostId, online: host?.status === "online" };
        });
  const hasPasskeyProtection = passkey.hasBundle && (passkey.passkeys.data?.length ?? 0) > 0;

  /**
   * Removal, per the dialog's promise: when the passkey protects an
   * about-to-be-orphaned online host, prove the passkey FIRST — the unlock's
   * heal re-anchors those hosts — and only then remove the device.
   */
  const removeWithProtection = async (device: BrowserDevice, orphans: OrphanVM[]) => {
    if (hasPasskeyProtection && orphans.some((o) => o.online)) {
      try {
        await passkey.unlock.mutateAsync();
      } catch {
        return; // the hook surfaced the error; nothing was removed
      }
    }
    revoke.mutate(device);
  };

  const revokedRows = allDevices.filter((device) => device.revoked_at);
  const liveRoot = allDevices.find((d) => d.is_root && d.revoked_at === null);
  const rootFingerprint = liveRoot ? deviceFingerprints.data?.get(liveRoot.id) : undefined;
  // Per-host approval survives only toward LEGACY hosts (mesh R9): chain-capable
  // hosts refuse it, and the account ceremony covers them instead.
  const canApproveLegacy =
    currentDevice !== undefined &&
    trustMap
      .trustedHostIdsFor(currentDevice.id)
      .some((hostId) => trustMap.hostsById.get(hostId)?.supports_account_chains !== true);
  const waitingDevices = deviceRows.filter((vm) => vm.waiting && !vm.isThisDevice);

  const passkeyNudge =
    !nudgeDismissed &&
    passkey.passkeys.data !== undefined &&
    passkey.passkeys.data.length === 0 &&
    trustMap.keyedHosts.length > 0;

  return (
    <section className="space-y-7" data-testid="access-panel">
      <header>
        <h2 className="text-lg font-semibold">Access</h2>
        <p className="text-sm text-muted-foreground">
          Every approved device reaches every host — and only you can approve one.
        </p>
      </header>

      {/* ----- this-browser state banners (identity lifecycle) ----- */}
      {registration.isError && (
        <div className="space-y-2 rounded-md border border-border p-3" role="alert">
          <p className="text-sm text-destructive">
            This device could not register its identity. Approvals and terminals are unavailable
            here until it succeeds.
          </p>
          <Button size="sm" variant="secondary" onClick={() => void registration.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {registration.data?.status === "cleanup_pending" && (
        <div className="space-y-2 rounded-md border border-border p-3" role="alert">
          <p className="text-sm text-amber-700 dark:text-amber-300">
            This device was removed, but deleting its local key failed. Nothing can use it anymore;
            retry to finish cleaning up.
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void retryCleanup(registration.data!.publicKey)}
          >
            Retry
          </Button>
        </div>
      )}
      {registration.data?.status === "revoked" && (
        <div className="space-y-2 rounded-md border border-border p-3" role="status">
          <p className="text-sm">
            This device was removed{describeRemoval(allDevices, registration.data.publicKey)}. It
            can start over as a new device — it will appear in the list, waiting for approval.
          </p>
          <Button size="sm" onClick={() => void startFresh(registration.data!.publicKey)}>
            Start over
          </Button>
        </div>
      )}

      {/* ----- this device is the one waiting ----- */}
      {showWaitingCallout && (
        <div
          className="space-y-2 rounded-md border border-amber-600/50 p-3"
          data-testid="untrusted-callout"
        >
          <p className="text-sm font-medium">This device is waiting for approval</p>
          <p className="text-sm text-muted-foreground">
            Approve it from a device you already use — you'll type this device's number there
            {passkey.hasBundle ? ", or use your passkey here" : ""}.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {passkey.hasBundle && (
              <Button
                size="sm"
                disabled={!passkey.supported || passkey.busy}
                onClick={() => passkey.unlock.mutate()}
                data-testid="unlock-trust"
              >
                {passkey.unlock.isPending ? "Checking…" : "Use passkey"}
              </Button>
            )}
            <Link
              className="text-xs text-muted-foreground underline"
              href="/device"
              onClick={() => closeSettings()}
            >
              No other device? Possess a host directly
            </Link>
          </div>
        </div>
      )}

      {(error || devices.error) && (
        <p className="text-sm text-destructive" role="alert">
          {error ?? `Failed to load devices: ${String(devices.error)}`}
        </p>
      )}
      {passkey.status !== null && (
        <p className="text-sm font-medium" role="status" data-testid="trust-status">
          {passkey.status}
        </p>
      )}
      {passkey.error !== null && (
        <p className="text-sm text-destructive" role="alert" data-testid="trust-error">
          {passkey.error}
        </p>
      )}

      {/* ----- devices ----- */}
      <section>
        <div className="mb-2.5 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Your devices
          </h3>
          <button
            type="button"
            onClick={() => setNewDeviceHint((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="size-3.5" />
            New device
          </button>
        </div>
        {newDeviceHint && (
          <p className="mb-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            Sign in to your account on the new device. It appears here the moment it does, waiting
            for approval.
          </p>
        )}
        <div className="divide-y divide-border rounded-xl border border-border">
          {devices.isLoading && deviceRows.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground">Loading devices…</div>
          )}
          {deviceRows.map((vm) => {
            const device = deviceById(vm.id);
            return (
              <div
                key={vm.id}
                className="relative flex items-center gap-3 px-4 py-3"
                data-testid="device-row"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  {vm.kind === "phone" ? (
                    <Smartphone className="size-4" />
                  ) : (
                    <Laptop className="size-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{vm.name}</span>
                    {vm.isThisDevice && (
                      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        This device
                      </span>
                    )}
                    {vm.waiting && (
                      <span
                        className="shrink-0 whitespace-nowrap rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                        data-testid="waiting-pill"
                      >
                        Waiting for approval
                      </span>
                    )}
                  </div>
                  {/* The provenance is the audit surface — it wraps rather than
                      truncates on narrow screens, where who/when matters most. */}
                  <p className="text-xs leading-relaxed text-muted-foreground sm:truncate">
                    {vm.provenance}
                    {!vm.waiting && <span className="sm:hidden"> · {seen(vm.lastSeen)}</span>}
                  </p>
                </div>
                {vm.waiting && !vm.isThisDevice && currentTrusted && device && (
                  <Button
                    size="sm"
                    onClick={() => requestApproval(vm.id)}
                    data-testid="approve-device"
                  >
                    Approve…
                  </Button>
                )}
                {!vm.waiting && (
                  <span className="hidden shrink-0 text-xs text-muted-foreground/70 sm:block">
                    {seen(vm.lastSeen)}
                  </span>
                )}
                {device && (
                  <RowMenu
                    label={`Options for ${vm.name}`}
                    open={openMenuId === vm.id}
                    onToggle={() => setOpenMenuId(openMenuId === vm.id ? null : vm.id)}
                    onRename={() => {
                      setOpenMenuId(null);
                      setRenameTarget(device);
                      setRenameValue(device.label ?? "");
                    }}
                    onRemove={() => {
                      setOpenMenuId(null);
                      setRemoveTarget(device);
                    }}
                  />
                )}
              </div>
            );
          })}
          {!devices.isLoading && deviceRows.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground">No devices yet.</div>
          )}
        </div>
      </section>

      {/* ----- hosts ----- */}
      <section>
        <div className="mb-2.5 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Your hosts
          </h3>
          <Link
            href="/device"
            onClick={() => closeSettings()}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="size-3.5" />
            Possess a host
          </Link>
        </div>
        <div className="divide-y divide-border rounded-xl border border-border">
          {view.hosts.map((host) => (
            <div key={host.id} className="flex items-center gap-3 px-4 py-3" data-testid="host-row">
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ${host.online ? "" : "opacity-60"}`}
              >
                <MonitorCog className="size-4" />
              </span>
              <div className={`min-w-0 flex-1 ${host.online ? "" : "opacity-60"}`}>
                <p className="truncate font-mono text-sm text-foreground">{host.name}</p>
                <p className="text-xs leading-relaxed text-muted-foreground sm:truncate">
                  {host.provenance}
                </p>
              </div>
              <span
                className={`flex shrink-0 items-center gap-1.5 text-xs ${
                  host.online
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground/60"
                }`}
              >
                <span
                  className={`size-1.5 rounded-full ${host.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                />
                {host.online ? "Online" : "Offline"}
              </span>
            </div>
          ))}
          {view.hosts.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground">
              No hosts yet. Run <code className="font-mono">spawnd possess</code> on one.
            </div>
          )}
        </div>
      </section>

      {/* ----- the one passkey nudge (R8, stated once, dismissible) ----- */}
      {passkeyNudge && (
        <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <KeyRound className="size-4" />
          </span>
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
            If you lose every device, a passkey brings everything back.
          </p>
          <button
            type="button"
            onClick={() => passkey.setUp.mutate()}
            disabled={!passkey.supported || passkey.busy}
            className="shrink-0 text-xs font-medium text-foreground transition-colors hover:opacity-80"
            data-testid="setup-passkey"
          >
            {passkey.setUp.isPending ? "Adding…" : "Add passkey"}
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setNudgeDismissed(true);
              if (user) window.localStorage.setItem(NUDGE_DISMISSED_KEY(user.id), "1");
            }}
            className="shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* ----- history ----- */}
      {view.history.length > 0 && (
        <section>
          <div className="mb-2.5 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              History
            </h3>
            {view.history.length > 3 && (
              <button
                type="button"
                onClick={() => setHistoryOpen((v) => !v)}
                className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {historyOpen ? "Less" : "Everything"}
              </button>
            )}
          </div>
          <ul className="space-y-2.5" data-testid="trust-log">
            {(historyOpen ? view.history : view.history.slice(0, 3)).map((event) => (
              <li key={event.id} className="flex items-baseline gap-2.5 text-sm">
                <span
                  className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${
                    event.kind === "removed" ? "bg-red-500/80" : "bg-muted-foreground/40"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{event.text}</span>
                <span className="shrink-0 text-xs text-muted-foreground/60">{event.when}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ----- advanced: everything the two nouns don't cover ----- */}
      <details data-testid="access-advanced">
        <summary className="cursor-pointer text-sm text-muted-foreground">Advanced</summary>
        <div className="mt-3 space-y-4">
          {/* Endorsed already? Then the endorsements carry host keys this
              browser can verify for itself. */}
          {user && currentDevice && (
            <IntroductionPanel accountId={user.id} deviceId={currentDevice.id} />
          )}

          {/* Legacy per-host approval (mesh R9): only toward hosts that have
              not advertised account-chain support. */}
          {canApproveLegacy && (waitingDevices.length > 0 || legacyNote !== null) && user && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-sm font-medium">Approve for older hosts</p>
              <p className="text-xs text-muted-foreground">
                Some of your hosts run older software that needs a per-host approval with a
                fingerprint check.
              </p>
              {waitingDevices.map((vm) => {
                const device = deviceById(vm.id);
                const fingerprint = device ? deviceFingerprints.data?.get(device.id) : undefined;
                if (!device) return null;
                return (
                  <div key={vm.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm">{vm.name}</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={fingerprint === undefined}
                        onClick={() => setLegacyApproveId(legacyApproveId === vm.id ? null : vm.id)}
                      >
                        Approve…
                      </Button>
                    </div>
                    {legacyApproveId === vm.id && fingerprint !== undefined && (
                      <EndorseDevicePanel
                        accountId={user.id}
                        target={device}
                        targetFingerprint={fingerprint}
                        onDone={(summary) => {
                          setLegacyApproveId(null);
                          setLegacyNote(summary);
                        }}
                        onCancel={() => setLegacyApproveId(null)}
                      />
                    )}
                  </div>
                );
              })}
              {legacyNote !== null && (
                <p className="text-sm font-medium" role="status">
                  {legacyNote}
                </p>
              )}
            </div>
          )}

          {/* This device's own key fingerprint — what the legacy approval on
              another device asks to compare. */}
          {currentDevice && (
            <div className="rounded-md border border-border p-3">
              <p className="text-sm font-medium">This device's fingerprint</p>
              <p
                className="mt-1 break-all font-mono text-xs text-muted-foreground"
                data-testid="browser-fingerprint"
              >
                {deviceFingerprints.data?.get(currentDevice.id) ?? "…"}
              </p>
            </div>
          )}

          {/* Forget local host trust (recovery for refused pins). */}
          <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Forget hosts on this device</p>
              <p className="text-xs text-muted-foreground">
                Removes every host this device recognizes; connections are unprotected until trusted
                again.
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={passkey.busy || (passkey.localPins.data?.length ?? 0) === 0}
              onClick={() => passkey.forget.mutate()}
              data-testid="forget-trust"
            >
              {passkey.forget.isPending ? "Forgetting…" : "Forget"}
            </Button>
          </div>

          {/* Root revocation: the compromise response. The root never appears
              in the roster; this is its one control. */}
          {liveRoot && (
            <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Reset passkey trust</p>
                <p className="text-xs text-muted-foreground">
                  If you suspect your passkey was compromised: everything it approved loses that
                  trust immediately, and your next passkey use starts a fresh anchor.
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={revoke.isPending || rootFingerprint === undefined}
                data-testid="revoke-root"
                onClick={() => {
                  if (
                    confirm(
                      `Reset passkey trust?\n\nEvery device and host anchored on your passkey ` +
                        `loses that trust immediately. Do this if you suspect the passkey was ` +
                        `compromised. The next passkey use mints a fresh anchor and re-approves ` +
                        `your devices.\n\nIts key fingerprint is ${rootFingerprint}.`,
                    )
                  ) {
                    revoke.mutate(liveRoot);
                  }
                }}
              >
                Reset…
              </Button>
            </div>
          )}

          {/* Removed-device history. */}
          {revokedRows.length > 0 && (
            <div className="rounded-md border border-border p-3">
              <p className="text-sm font-medium">Removed devices ({revokedRows.length})</p>
              <ul className="mt-1 space-y-1">
                {revokedRows.map((device) => (
                  <li key={device.id} className="text-xs text-muted-foreground">
                    {device.label ?? "Unnamed device"} · removed{" "}
                    {device.revoked_at ? new Date(device.revoked_at).toLocaleDateString() : ""}
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                disabled={prune.isPending}
                onClick={() => {
                  if (
                    confirm(
                      `Clear ${revokedRows.length} removed device${
                        revokedRows.length === 1 ? "" : "s"
                      } from history?\n\nRemoval still stands — a cleared device can only ` +
                        "come back through a fresh approval, like any new device.",
                    )
                  ) {
                    prune.mutate();
                  }
                }}
              >
                {prune.isPending ? "Clearing…" : "Clear history"}
              </Button>
            </div>
          )}

          {/* Storage diagnostics. */}
          <div className="rounded-md border border-border p-3 text-sm" data-testid="storage-report">
            <p className="font-medium">Browser storage</p>
            {passkey.storage.isLoading || passkey.storage.data === undefined ? (
              <p className="text-muted-foreground">checking…</p>
            ) : (
              <ul className="mt-1 font-mono text-xs text-muted-foreground">
                <li>device identity persisted: {String(passkey.storage.data.identityPersisted)}</li>
                <li>
                  plain value persists: {String(passkey.storage.data.probe.plainValuePersists)}
                </li>
                <li>
                  Ed25519 key persists: {String(passkey.storage.data.probe.ed25519KeyPersists)}
                </li>
                <li>ECDSA key persists: {String(passkey.storage.data.probe.ecdsaKeyPersists)}</li>
                {passkey.storage.data.probe.failure !== null && (
                  <li className="text-destructive">
                    failure: {passkey.storage.data.probe.failure}
                  </li>
                )}
              </ul>
            )}
            {passkey.storage.data !== undefined && !passkey.storage.data.identityPersisted && (
              <p className="mt-2 text-destructive">
                This browser did not keep its device identity. It will mint a new one on every load
                and can never be trusted, so protected connections cannot work here.
              </p>
            )}
          </div>
        </div>
      </details>

      {/* ----- rename dialog ----- */}
      <Dialog.Root
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[min(100vw-2rem,380px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 shadow-2xl focus:outline-none">
            <Dialog.Title className="text-base font-medium">Rename device</Dialog.Title>
            <Dialog.Description className="sr-only">
              A name for recognition; it changes no trust.
            </Dialog.Description>
            <form
              className="mt-3 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!renameTarget) return;
                const trimmed = renameValue.trim();
                rename.mutate({
                  id: renameTarget.id,
                  label: trimmed === "" ? null : trimmed.slice(0, 64),
                });
              }}
            >
              <Input
                autoFocus
                value={renameValue}
                maxLength={64}
                placeholder="e.g. Work laptop, Pixel phone"
                onChange={(event) => setRenameValue(event.target.value)}
                disabled={rename.isPending}
              />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRenameTarget(null)}
                  disabled={rename.isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={rename.isPending}>
                  {rename.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ----- remove dialog ----- */}
      <Dialog.Root
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[min(100vw-2rem,420px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 shadow-2xl focus:outline-none">
            <Dialog.Title className="sr-only">Remove device</Dialog.Title>
            <Dialog.Description className="sr-only">
              Removing a device revokes its access to every host, permanently.
            </Dialog.Description>
            {removeTarget && (
              <RemoveDeviceDialog
                deviceName={removeTarget.label ?? "Unnamed device"}
                isThisDevice={removeTarget.public_key === currentPublicKey}
                orphans={removeOrphans}
                hasPasskey={hasPasskeyProtection}
                busy={revoke.isPending || passkey.unlock.isPending}
                error={error}
                onRemove={() => void removeWithProtection(removeTarget, removeOrphans)}
                onCancel={() => setRemoveTarget(null)}
                onAddPasskey={() => {
                  setRemoveTarget(null);
                  passkey.setUp.mutate();
                }}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

/** "Now" stays bare; any other last-seen value gets its label so two dates on a
    row can't be confused ("Approved … Jun 3" vs "Seen Aug 12"). */
function seen(lastSeen: string): string {
  return lastSeen === "Now" ? "Now" : `Seen ${lastSeen}`;
}

/** " — Aug 20, by Chrome on Mac" when the tombstone is still known (R4: the
    sharp end of a removal names its remover). Empty when history was cleared. */
function describeRemoval(devices: BrowserDevice[], publicKey: string): string {
  const tombstone = devices.find((d) => d.public_key === publicKey && d.revoked_at !== null);
  if (!tombstone?.revoked_at) return "";
  const when = new Date(tombstone.revoked_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const remover = devices.find((d) => d.id === tombstone.revoked_by_device_id);
  return remover?.label ? ` — ${when}, by ${remover.label}` : ` — ${when}`;
}

/**
 * Row options as an inline menu, not a portal: the settings dialog is a modal
 * Radix layer, and it swallows pointer events aimed at anything portaled
 * outside its subtree.
 */
function RowMenu({
  label,
  open,
  onToggle,
  onRename,
  onRemove,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={onToggle}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-3 top-11 z-10 min-w-36 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={onRename}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={onRemove}
            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-accent"
          >
            Remove…
          </button>
        </div>
      )}
    </>
  );
}
