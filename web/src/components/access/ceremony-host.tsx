"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { consumeApprovalRequest, useApprovalRequest } from "@/components/access/ceremony-store";
import { NumberCheck } from "@/components/access/number-check";
import { useSettingsDialog } from "@/components/settings/settings-dialog-store";
import { useDeviceTrustMap } from "@/components/trust/device-endorsement";
import { Button } from "@/components/ui/button";
import { CEREMONY_SAS_DIGITS } from "@/lib/add-device-ceremony";
import { type BrowserDevice, browserDevices, trust } from "@/lib/api";
import { type ApproveCeremonyView, useApproveDeviceCeremony } from "@/lib/approve-ceremony";
import { useAuth } from "@/lib/auth";
import { loadBrowserDeviceIdentity } from "@/lib/browser-device-identity";
import { useBrowserDeviceRegistration } from "@/lib/browser-device-registration";
import { approvalToastEligible, pickApprovalToastDevice } from "@/lib/session-approval";
import { computeTrustRoster } from "@/lib/trust-roster";

/**
 * The one place the approve-a-device ceremony runs (docs/TRUST_UX.md). Mounted
 * app-level so:
 *
 * - a NEW device shows its number the moment an approver starts, wherever the
 *   operator happens to be in the app;
 * - an APPROVER gets the corner toast when an unapproved sign-in appears
 *   (R4 made visible), and the number-entry dialog when they act on it — from
 *   the toast or from the Access roster (via the ceremony store).
 *
 * Exactly one instance drives the relay; every surface that wants a ceremony
 * asks through `requestApproval`.
 */
export function AccessCeremonyHost() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const settingsTab = useSettingsDialog();
  const registration = useBrowserDeviceRegistration(user?.id);
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled: user !== null,
    // The toast is how an operator learns a new sign-in is waiting; poll
    // gently app-wide (the Access panel polls faster while open).
    refetchInterval: 10_000,
  });
  const localIdentity = useQuery({
    queryKey: ["browser-device-local-identity", user?.id],
    queryFn: () => loadBrowserDeviceIdentity(user!.id),
    enabled: user !== null,
    retry: false,
  });
  const edges = useQuery({
    queryKey: ["account-endorsements"],
    queryFn: trust.accountEndorsements,
    enabled: user !== null,
    refetchInterval: 15_000,
  });
  const trustMap = useDeviceTrustMap(user !== null);

  // The roster fetched before this browser's own registration landed cannot
  // contain this device, and until it does `canApprove` reads false — the
  // toast would wait a full poll cycle for no reason. Refetch the moment the
  // identity is ready (same pattern as the Access panel).
  useEffect(() => {
    if (registration.data?.status === "ready") {
      void qc.invalidateQueries({ queryKey: ["browser-devices"] });
    }
  }, [qc, registration.data?.status]);

  const currentPublicKey =
    registration.data?.publicKey ?? localIdentity.data?.publicKeyWire ?? null;
  const currentDevice =
    (devices.data ?? []).find((device) => device.public_key === currentPublicKey) ??
    (registration.data?.status === "ready" ? registration.data.device : null);

  const ceremony = useApproveDeviceCeremony({
    accountId: user?.id ?? "",
    currentDevice: currentDevice ?? null,
    identity: localIdentity.data ?? null,
    devices: devices.data ?? [],
    enabled: user !== null && currentDevice !== null,
  });

  // The Access roster (or anything else) asks for a ceremony through the
  // store; this single driver starts it.
  const requestedId = useApprovalRequest();
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per request; ceremony.start reads live state
  useEffect(() => {
    if (requestedId === null) return;
    const target = (devices.data ?? []).find((d) => d.id === requestedId);
    consumeApprovalRequest();
    if (target) ceremony.start(target);
  }, [requestedId, devices.data]);

  // Waiting devices (unapproved sign-ins), for the corner toast: live, not the
  // root, not this device, unreachable from any anchor, holding no pins.
  const roster = computeTrustRoster(devices.data ?? [], edges.data ?? [], trustMap.pinnedDeviceIds);
  const canApprove =
    currentDevice !== null && (roster.get(currentDevice.id)?.chainTrusted ?? false);
  // Ignore is per sitting AND per ask: a device that actively asks again after
  // being ignored (it tried to open an agent session) re-raises the toast.
  const [ignoredAt, setIgnoredAt] = useState<Map<string, number>>(new Map());
  const waiting =
    !canApprove || !trustMap.ready || !edges.data
      ? []
      : (devices.data ?? []).filter(
          (d) =>
            d.revoked_at === null &&
            !d.is_root &&
            d.id !== currentDevice?.id &&
            !(roster.get(d.id)?.chainTrusted ?? false) &&
            trustMap.trustedHostIdsFor(d.id).length === 0 &&
            approvalToastEligible(d, ignoredAt.get(d.id)),
        );
  // One toast at a time (the most urgent ask first); the settings dialog
  // already shows waiting rows.
  const toastDevice =
    settingsTab === null && ceremony.ceremonies.length === 0
      ? pickApprovalToastDevice(waiting)
      : null;

  return (
    <>
      {toastDevice && (
        <ApproveRequestToast
          device={toastDevice}
          onEnterNumber={() => ceremony.start(toastDevice)}
          onIgnore={() => setIgnoredAt((prev) => new Map(prev).set(toastDevice.id, Date.now()))}
        />
      )}
      {ceremony.ceremonies.map((view) => (
        <CeremonyDialog
          key={view.pairingId}
          view={view}
          error={ceremony.error}
          onSubmit={(digits) => {
            const pairing = ceremony.pairings.find((p) => p.id === view.pairingId);
            if (pairing) ceremony.submitDigits(pairing, digits);
          }}
          onCancel={() => {
            ceremony.clearError();
            ceremony.cancel(view.pairingId);
          }}
          onDismiss={() => {
            ceremony.clearError();
            ceremony.dismiss(view.pairingId);
          }}
        />
      ))}
      {ceremony.error !== null && ceremony.ceremonies.length === 0 && (
        <CeremonyErrorToast message={ceremony.error} onDismiss={ceremony.clearError} />
      )}
    </>
  );
}

/**
 * A ceremony error with no dialog to carry it (e.g. starting the approval
 * failed before any pairing existed). Without this the failure is invisible
 * and the operator waits on nothing.
 */
function CeremonyErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      data-testid="ceremony-error-toast"
      className="fixed bottom-4 right-4 z-40 w-[320px] rounded-2xl border border-destructive/40 bg-card p-4 shadow-2xl shadow-black/30"
    >
      <p className="text-sm leading-relaxed text-foreground" role="alert">
        {message}
      </p>
      <div className="mt-3">
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function CeremonyDialog({
  view,
  error,
  onSubmit,
  onCancel,
  onDismiss,
}: {
  view: ApproveCeremonyView;
  /** The hook's ceremony-level error — a failed approve must say so, not blank the dialog. */
  error: string | null;
  onSubmit: (digits: string) => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const isApprover = view.role === "approver";
  const finished = view.phase === "done" || view.phase === "stopped";
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (open) return;
        if (finished) onDismiss();
        else onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="approve-ceremony"
          className="fixed left-1/2 top-1/2 z-[60] w-[min(100vw-2rem,420px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-6 shadow-2xl focus:outline-none"
        >
          <Dialog.Title className="text-center text-sm text-muted-foreground">
            {isApprover ? `Approve ${view.peerName}` : "Approve this device"}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            {isApprover
              ? "Enter the number shown on the new device."
              : "Enter this number on the device you already use."}
          </Dialog.Description>
          <NumberCheck
            phase={view.phase}
            mode={isApprover ? "enter" : "show"}
            digits={CEREMONY_SAS_DIGITS}
            number={view.number ?? undefined}
            otherScreen={isApprover ? "on the new device" : "on the device you already use"}
            doneText={
              isApprover
                ? `${view.peerName} is approved. Every host is ready.`
                : "This device is approved. Every host is ready."
            }
            entryError={view.entryError ?? undefined}
            slowHint={view.waitingSince !== null && Date.now() - view.waitingSince > 20_000}
            stoppedText="The number wasn't right, so nothing was trusted. You can start over from the device list."
            onSubmit={onSubmit}
            onNoMatch={onCancel}
            onDone={onDismiss}
            onClose={finished ? onDismiss : onCancel}
          />
          {error !== null && (
            <p
              className="mt-3 text-center text-sm text-destructive"
              data-testid="ceremony-error"
              role="alert"
            >
              {error}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The request as it arrives on whatever the operator is doing: a corner toast.
 * Approving opens the number check; Ignore dismisses — nothing is trusted from
 * this card alone.
 */
function ApproveRequestToast({
  device,
  onEnterNumber,
  onIgnore,
}: {
  device: BrowserDevice;
  onEnterNumber: () => void;
  onIgnore: () => void;
}) {
  const name = device.label ?? "Unnamed device";
  const isPhone = /iphone|ipad|android|pixel|phone|tablet/iu.test(name);
  // An active ask (it tried to open an agent session) reads differently from a
  // quiet sign-in: someone is standing at that device waiting on this one.
  const asking = device.approval_requested_at !== null;
  return (
    <div
      data-testid="approve-toast"
      className="fixed bottom-4 right-4 z-40 w-[320px] rounded-2xl border border-border bg-card p-4 shadow-2xl shadow-black/30"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {isPhone ? <Smartphone className="size-4" /> : <Laptop className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Approve {name}?</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {asking
              ? "It's asking for approval to reach your hosts. If that wasn't you, ignore this."
              : "It just signed in as you. If that wasn't you, ignore this."}
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={onEnterNumber}>
          Enter its number
        </Button>
        <Button size="sm" variant="ghost" onClick={onIgnore}>
          Ignore
        </Button>
      </div>
    </div>
  );
}
