"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { closeSettings, openSettings } from "@/components/settings/settings-dialog-store";
import { EndorseDevicePanel, useDeviceTrustMap } from "@/components/trust/device-endorsement";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type BrowserDevice, browserDevices, trust } from "@/lib/api";
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

export function DevicesPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const registration = useBrowserDeviceRegistration(user?.id);
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled: user !== null,
  });
  const localIdentity = useQuery({
    queryKey: ["browser-device-local-identity", user?.id],
    queryFn: () => loadBrowserDeviceIdentity(user!.id),
    enabled: user !== null,
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (registration.data?.status === "ready") {
      void qc.invalidateQueries({ queryKey: ["browser-devices"] });
    }
  }, [qc, registration.data?.status]);

  const currentPublicKey =
    registration.data?.publicKey ?? localIdentity.data?.publicKeyWire ?? null;
  const currentDevice =
    (devices.data ?? []).find((device) => device.public_key === currentPublicKey) ??
    (registration.data?.status === "ready" ? registration.data.device : undefined);

  // Derive each device's fingerprint locally from its key rather than trusting
  // the server's `fingerprint` field: this is the value the operator reads to
  // decide which device to revoke, so a hostile server must not be able to
  // mislabel one device with another's fingerprint. Mirrors the endorse page.
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
  const fingerprintFor = (device: BrowserDevice): string | null =>
    deviceFingerprints.data?.get(device.id) ?? null;

  const setRegistrationState = (state: BrowserDeviceRegistrationState) => {
    if (!user) return;
    qc.setQueryData(browserDeviceRegistrationQueryKey(user.id), state);
  };

  const revoke = useMutation({
    mutationFn: async (device: BrowserDevice) => {
      if (!user) throw new Error("not authenticated");
      const revoked = await browserDevices.revoke(device.id, device.public_key);
      if (
        revoked.id !== device.id ||
        revoked.public_key !== device.public_key ||
        revoked.revoked_at === null
      ) {
        throw new Error("Revocation response did not confirm the expected browser key");
      }
      if (device.public_key !== currentPublicKey) return revoked;

      // Disable identity-dependent actions in this tab immediately after the
      // server confirms revocation, even if durable local cleanup state cannot
      // be written or IndexedDB deletion fails below.
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
        throw new Error(`Server revocation succeeded, but local key cleanup failed: ${detail}`);
      }
      return revoked;
    },
    onSuccess: () => setError(null),
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
   * One explicit action for "this browser was revoked, get me going again":
   * clean up the dead local key (idempotent) and authorize minting a fresh
   * identity. Still a single deliberate user click — a revoked browser never
   * silently re-mints itself — but no longer two puzzle steps.
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

  // Advisory trust coverage for badges and flow routing (verification stays
  // fingerprint-only). Refreshes on its own, so "waiting for approval" flips
  // to trusted once the other browser signs.
  const trustMap = useDeviceTrustMap(user !== null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState<string | null>(null);
  const currentTrustedHosts = currentDevice ? trustMap.trustedHostIdsFor(currentDevice.id) : [];
  const canApproveOthers = currentTrustedHosts.length > 0;
  const bundle = useQuery({
    queryKey: ["trust", "bundle"],
    queryFn: () => trust.getBundle(),
    enabled: user !== null,
  });

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const rename = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string | null }) =>
      browserDevices.rename(id, label),
    onSuccess: () => {
      setRenamingId(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["browser-devices"] });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
  });
  const startRename = (device: BrowserDevice) => {
    setRenamingId(device.id);
    setRenameValue(device.label ?? "");
  };
  const submitRename = (device: BrowserDevice) => {
    const trimmed = renameValue.trim();
    rename.mutate({ id: device.id, label: trimmed === "" ? null : trimmed.slice(0, 64) });
  };

  // The list is the single source of rows; when the current device is known
  // from registration but the fetch has not caught up yet, synthesize its row
  // so "this browser" always has a home.
  const listed = devices.data ?? [];
  const rows: BrowserDevice[] =
    currentDevice && !listed.some((device) => device.id === currentDevice.id)
      ? [currentDevice as BrowserDevice, ...listed]
      : listed;
  const activeRows = rows
    .filter((device) => !device.revoked_at)
    .sort((a, b) => {
      if ((a.public_key === currentPublicKey) !== (b.public_key === currentPublicKey)) {
        return a.public_key === currentPublicKey ? -1 : 1;
      }
      return a.created_at < b.created_at ? 1 : -1;
    });
  const revokedRows = rows.filter((device) => device.revoked_at);

  const deviceName = (device: BrowserDevice) => device.label?.trim() || null;

  const renderRow = (device: BrowserDevice) => {
    const isCurrent = device.public_key === currentPublicKey;
    const derivedFingerprint = fingerprintFor(device);
    const name = deviceName(device);
    const isRenaming = renamingId === device.id;
    const trustedCount = trustMap.trustedHostIdsFor(device.id).length;
    const showTrustBadge = !device.revoked_at && trustMap.ready;
    return (
      <div key={device.id} className="p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            {isRenaming ? (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitRename(device);
                }}
              >
                <Input
                  autoFocus
                  value={renameValue}
                  maxLength={64}
                  placeholder="e.g. Work laptop, Pixel phone"
                  className="h-8 max-w-56 text-sm"
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setRenamingId(null);
                  }}
                  disabled={rename.isPending}
                />
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Save name"
                  disabled={rename.isPending}
                >
                  <Check className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Cancel rename"
                  onClick={() => setRenamingId(null)}
                  disabled={rename.isPending}
                >
                  <X className="size-4" />
                </Button>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={name ? "text-sm font-medium" : "text-sm italic text-muted-foreground"}
                >
                  {name ?? "Unnamed browser"}
                </span>
                {isCurrent && (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[11px]">
                    this browser
                  </span>
                )}
                {device.revoked_at && (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    revoked
                  </span>
                )}
                {showTrustBadge &&
                  (trustedCount > 0 ? (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      trusted · {trustedCount} host{trustedCount === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <span className="rounded border border-amber-600/50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                      not trusted yet
                    </span>
                  ))}
                {!device.revoked_at && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={`Rename ${name ?? "unnamed browser"}`}
                    title="Rename"
                    onClick={() => startRename(device)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                )}
              </div>
            )}
            {/* Fingerprints matter at approval time — the ceremony re-derives
                and shows them. Only this browser's own stays visible, since
                it's what gets read out to an approving device. */}
            {isCurrent && (
              <p
                className="break-all font-mono text-xs text-muted-foreground"
                data-testid="browser-fingerprint"
              >
                {derivedFingerprint ?? "…"}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Added {new Date(device.created_at).toLocaleDateString()}
              {device.revoked_at &&
                ` · revoked ${new Date(device.revoked_at).toLocaleDateString()}`}
            </p>
          </div>
          {!device.revoked_at ? (
            <div className="flex shrink-0 gap-2">
              {!isCurrent && trustMap.ready && trustedCount === 0 && canApproveOthers && (
                <Button
                  size="sm"
                  disabled={derivedFingerprint === null}
                  onClick={() => {
                    setApprovalNote(null);
                    setApprovingId(approvingId === device.id ? null : device.id);
                  }}
                >
                  Approve…
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={revoke.isPending || derivedFingerprint === null}
                onClick={() => {
                  const who = name ?? "this unnamed browser";
                  if (
                    confirm(
                      `Revoke ${who}?\n\nIt immediately loses terminal access on every host. ` +
                        `Its key fingerprint is ${derivedFingerprint}.`,
                    )
                  ) {
                    revoke.mutate(device);
                  }
                }}
              >
                Revoke
              </Button>
            </div>
          ) : isCurrent && registration.data?.status !== "revoked" ? (
            <Button size="sm" onClick={() => void startFresh(device.public_key)}>
              Start fresh on this browser
            </Button>
          ) : null}
        </div>
        {approvingId === device.id && user && derivedFingerprint !== null && (
          <EndorseDevicePanel
            accountId={user.id}
            target={device}
            targetFingerprint={derivedFingerprint}
            onDone={(summary) => {
              setApprovingId(null);
              setApprovalNote(summary);
            }}
            onCancel={() => setApprovingId(null)}
          />
        )}
      </div>
    );
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Browser devices</h2>
        <p className="text-sm text-muted-foreground">
          Browsers signed in to your account. A new browser needs approval from one that already
          works before hosts will accept it.
        </p>
      </div>
      {registration.isError && (
        <div className="space-y-2 rounded-md border border-border p-3" role="alert">
          <p className="text-sm text-destructive">
            This browser&apos;s identity registration failed. Terminal access and approvals are
            unavailable from here until it succeeds.
          </p>
          <Button size="sm" variant="secondary" onClick={() => void registration.refetch()}>
            Retry registration
          </Button>
        </div>
      )}
      {registration.data?.status === "cleanup_pending" && (
        <div className="space-y-2 rounded-md border border-border p-3" role="alert">
          <p className="text-sm text-amber-700 dark:text-amber-300">
            This browser&apos;s key is revoked on the server, but deleting the local copy failed.
            Nothing can use it anymore; retry to finish cleaning up.
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void retryCleanup(registration.data!.publicKey)}
          >
            Retry local key deletion
          </Button>
        </div>
      )}
      {registration.data?.status === "revoked" && (
        <div className="space-y-2 rounded-md border border-border p-3" role="status">
          <p className="text-sm">
            This browser&apos;s previous key is revoked. Start fresh to mint a new identity — it
            begins untrusted and needs approval like any new device.
          </p>
          <Button size="sm" onClick={() => void startFresh(registration.data!.publicKey)}>
            Start fresh on this browser
          </Button>
        </div>
      )}

      {(error || devices.error || localIdentity.error) && (
        <p className="text-sm text-destructive" role="alert">
          {error ??
            `Failed to load browser devices: ${String(devices.error ?? localIdentity.error)}`}
        </p>
      )}

      {currentDevice &&
        trustMap.ready &&
        trustMap.keyedHosts.length > 0 &&
        currentTrustedHosts.length === 0 &&
        registration.data?.status === "ready" && (
          <div
            className="space-y-2 rounded-md border border-amber-600/50 p-3"
            data-testid="untrusted-callout"
          >
            <p className="text-sm font-medium">This browser can&apos;t open terminals yet</p>
            <p className="text-sm text-muted-foreground">
              On a browser that already works, open this page, press <b>Approve</b> next to this
              device, and check it shows:
            </p>
            <p className="break-all rounded bg-muted px-2 py-1.5 font-mono text-sm font-semibold">
              {fingerprintFor(currentDevice) ?? "…"}
            </p>
            <p className="text-xs text-muted-foreground">
              {bundle.data != null && (
                <>
                  Have your passkey?{" "}
                  <button type="button" className="underline" onClick={() => openSettings("trust")}>
                    Unlock saved trust
                  </button>{" "}
                  instead.{" "}
                </>
              )}
              No other working browser?{" "}
              <Link className="underline" href="/device" onClick={() => closeSettings()}>
                Connect a host
              </Link>{" "}
              directly.
            </p>
          </div>
        )}

      {approvalNote !== null && (
        <p className="text-sm font-medium" role="status">
          {approvalNote}
        </p>
      )}

      <div className="divide-y divide-border rounded-md border border-border">
        {devices.isLoading && rows.length === 0 && (
          <div className="p-3 text-sm text-muted-foreground">Loading browser devices...</div>
        )}
        {!devices.isLoading && !devices.error && rows.length === 0 && (
          <div className="p-3 text-sm text-muted-foreground">No registered browsers.</div>
        )}
        {activeRows.map(renderRow)}
      </div>

      {revokedRows.length > 0 && (
        <details open={revokedRows.some((device) => device.public_key === currentPublicKey)}>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Revoked devices ({revokedRows.length})
          </summary>
          <div className="mt-2 divide-y divide-border rounded-md border border-border opacity-70">
            {revokedRows.map(renderRow)}
          </div>
        </details>
      )}

      <p className="text-xs text-muted-foreground">
        Passkeys and carrying trust between devices live on{" "}
        <button type="button" className="underline" onClick={() => openSettings("trust")}>
          Device trust
        </button>
        .
      </p>
    </section>
  );
}
