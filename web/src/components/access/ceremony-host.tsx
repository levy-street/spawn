"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { consumeApprovalRequest, useApprovalRequest } from "@/components/access/ceremony-store";
import { NumberCheck } from "@/components/access/number-check";
import { useSettingsDialog } from "@/components/settings/settings-dialog-store";
import { useDeviceTrustMap } from "@/components/trust/device-endorsement";
import { Button } from "@/components/ui/button";
import { CEREMONY_SAS_DIGITS } from "@/lib/add-device-ceremony";
import { browserDevices, trust } from "@/lib/api";
import { type ApproveCeremonyView, useApproveDeviceCeremony } from "@/lib/approve-ceremony";
import { useAuth } from "@/lib/auth";
import { loadBrowserDeviceIdentity } from "@/lib/browser-device-identity";
import { useBrowserDeviceRegistration } from "@/lib/browser-device-registration";

/**
 * The one place the approve-a-device ceremony runs (docs/TRUST_UX.md). Mounted
 * app-level so:
 *
 * - a NEW device shows its number the moment an approver starts, wherever the
 *   operator happens to be in the app;
 * - an APPROVER gets the number-entry dialog when they act on a waiting row
 *   in the Access roster (via the ceremony store). A device that knocks is
 *   answered by the DeviceApprovalPrompt modal instead; the corner toast that
 *   used to offer "enter its number" for every unapproved sign-in is gone.
 *
 * Exactly one instance drives the relay; every surface that wants a ceremony
 * asks through `requestApproval`.
 */
export function AccessCeremonyHost() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const _settingsTab = useSettingsDialog();
  const registration = useBrowserDeviceRegistration(user?.id);
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled: user !== null,
    // A new sign-in shows up in the Access roster; poll gently app-wide (the
    // panel polls faster while open).
    refetchInterval: 10_000,
  });
  const localIdentity = useQuery({
    queryKey: ["browser-device-local-identity", user?.id],
    queryFn: () => loadBrowserDeviceIdentity(user!.id),
    enabled: user !== null,
    retry: false,
  });
  const _edges = useQuery({
    queryKey: ["account-endorsements"],
    queryFn: trust.accountEndorsements,
    enabled: user !== null,
    refetchInterval: 15_000,
  });
  const _trustMap = useDeviceTrustMap(user !== null);
  // The roster fetched before this browser's own registration landed cannot
  // contain this device, and a ceremony started before it appears would wait a
  // full poll cycle for no reason. Refetch the moment the identity is ready
  // (same pattern as the Access panel).
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

  return (
    <>
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
  const finished = view.phase === "done" || view.phase === "half-done" || view.phase === "stopped";
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
            halfDoneText={
              isApprover
                ? `${view.peerName} can reach your hosts, but it didn't finish linking back. Approve it again from the device list to finish the link.`
                : "Approved on this side, but the other device didn't finish. Approve this device again from a device you already use to finish the link."
            }
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
