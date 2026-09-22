"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useDeviceTrustMap } from "@/components/trust/device-endorsement";
import { Button } from "@/components/ui/button";
import { browserDevices, trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBrowserDeviceRegistration } from "@/lib/browser-device-registration";
import { isAgentSessionPath } from "@/lib/session-approval";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";
import { usePasskeyTrust } from "@/lib/trust-passkeys";
import { computeTrustRoster } from "@/lib/trust-roster";

/** Roster poll cadence while the card is on screen. */
export const GATE_POLL_UP_MS = 4_000;
/** Roster poll cadence for an open session whose device is already trusted. */
export const GATE_POLL_DOWN_MS = 30_000;

/**
 * The approval card over a dead terminal (docs/TRUST_UX.md §3, §7).
 *
 * An unapproved device that opens an agent session cannot connect — the daemon
 * refuses its offer (no chain to an anchor) and nothing here changes that.
 * What this gate does is turn the refusal into the flow: it covers the session
 * with the "one step left" card, stamps the device's approval request so every
 * other device's toast surfaces (or re-surfaces) right now, and offers the two
 * escapes that need no other device — the passkey and possessing a host from
 * its terminal.
 *
 * The number itself is NOT shown here: when an approver starts the ceremony,
 * the app-level ceremony host's dialog (which sits above this card) takes over
 * on both sides, exactly as it does from the Access roster. This card yields
 * while any pairing involving this device is live.
 */
export function SessionApprovalGate() {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const sessionOpen = isAgentSessionPath(pathname);
  const enabled = user !== null && sessionOpen;

  const registration = useBrowserDeviceRegistration(user?.id);
  // While the card is up the flip to "approved" should feel immediate, matching
  // the Access panel's open-state cadence. Every open agent session runs these
  // two queries, nearly always for a device that is already trusted, so with
  // the card down they idle — the interval is read when each refetch is
  // scheduled, so the ref below is current by then.
  const cardUp = useRef(false);
  const gateInterval = () => (cardUp.current ? GATE_POLL_UP_MS : GATE_POLL_DOWN_MS);
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled,
    refetchInterval: gateInterval,
  });
  const edges = useQuery({
    queryKey: ["account-endorsements"],
    queryFn: trust.accountEndorsements,
    enabled,
    refetchInterval: gateInterval,
  });
  const trustMap = useDeviceTrustMap(enabled);
  const passkey = usePasskeyTrust();

  const currentPublicKey = registration.data?.publicKey ?? null;
  const currentDevice =
    (devices.data ?? []).find((device) => device.public_key === currentPublicKey) ??
    (registration.data?.status === "ready" ? registration.data.device : undefined);

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
  // Same condition as the Access panel's waiting callout: only hosts with an
  // identity key refuse an unapproved device, so only they make this gate real.
  const show =
    sessionOpen &&
    ready &&
    trustMap.keyedHosts.length > 0 &&
    currentDevice !== undefined &&
    !currentTrusted;
  cardUp.current = show;

  // Yield to the ceremony dialog the moment a pairing involving this device is
  // live — the number check renders above and replaces this card's guidance.
  const pairings = useQuery({
    queryKey: ["device-pairings", currentDevice?.id ?? null],
    queryFn: () => trust.listPairings(currentDevice?.id ?? ""),
    refetchInterval: 1500,
    enabled: show && currentDevice !== undefined,
  });
  const ceremonyLive = (pairings.data ?? []).length > 0;

  // Ask out loud, once per blocked sitting. The roster stamp marks this device
  // as asking; the knock raises the approval prompt on every trusted screen
  // and pushes to the account's phones (docs/TRUST_UX.md §3).
  const request = useMutation({
    mutationFn: async (device: { id: string; public_key: string }) => {
      await browserDevices.requestApproval(device.id, device.public_key);
      await trust.requestDeviceApproval(device.id);
    },
  });
  // What the approver compares against: derived here from this browser's own
  // key, never served (mesh B5).
  const fingerprint = useQuery({
    queryKey: ["browser-device-fingerprint", currentDevice?.public_key ?? null],
    queryFn: () => ed25519PublicKeyFingerprint(currentDevice?.public_key ?? ""),
    enabled: show && currentDevice !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const askedForRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per device per sitting; reads live state
  useEffect(() => {
    if (!show || currentDevice === undefined) return;
    if (askedForRef.current === currentDevice.id) return;
    askedForRef.current = currentDevice.id;
    request.mutate({ id: currentDevice.id, public_key: currentDevice.public_key });
  }, [show, currentDevice?.id]);

  if (!show || ceremonyLive) return null;

  const deviceName = currentDevice.label ?? "This device";
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="session-approval-gate"
          className="fixed left-1/2 top-1/2 z-50 w-[min(100vw-2rem,420px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-6 shadow-2xl focus:outline-none"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title className="text-center text-base font-semibold">One step left</Dialog.Title>
          <Dialog.Description className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
            Approve {deviceName === "This device" ? "this device" : `“${deviceName}”`} from a device
            you already use{passkey.hasBundle ? ", or sign in here with your passkey" : ""}.
          </Dialog.Description>

          {fingerprint.data !== undefined && (
            <div className="mt-4 space-y-1.5" data-testid="session-gate-fingerprint">
              <p className="text-center text-xs text-muted-foreground">
                This device&apos;s fingerprint. The approving screen must show exactly this.
              </p>
              <p className="select-all break-all rounded-lg border border-border bg-muted/60 px-3 py-2 text-center font-mono text-sm font-semibold tracking-wide">
                {fingerprint.data}
              </p>
            </div>
          )}

          <div
            className="mt-4 flex items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden />
            <span>
              {request.isSuccess
                ? "Your other devices have been asked. This closes on its own once one approves."
                : "Waiting for approval…"}
            </span>
          </div>

          {passkey.status !== null && (
            <p className="mt-3 text-center text-sm font-medium" role="status">
              {passkey.status}
            </p>
          )}
          {/* A failed or partial passkey attempt must be visible here — the
              card otherwise keeps saying "waiting" over a silent failure. */}
          {passkey.error !== null && (
            <p className="mt-3 text-center text-sm text-destructive" role="alert">
              {passkey.error}
            </p>
          )}

          <div className="mt-5 flex flex-col items-center gap-3">
            {passkey.hasBundle && (
              <Button
                className="w-full"
                disabled={!passkey.supported || passkey.busy}
                onClick={() => passkey.unlock.mutate()}
                data-testid="session-gate-passkey"
              >
                {passkey.unlock.isPending ? "Checking…" : "Use passkey"}
              </Button>
            )}
            <Button variant="ghost" className="w-full" onClick={() => router.push("/app")}>
              Go back
            </Button>
            <Link href="/device" className="text-xs text-muted-foreground underline">
              No other device? Possess a host directly
            </Link>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
