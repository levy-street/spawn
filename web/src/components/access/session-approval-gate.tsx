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
import { usePasskeyTrust } from "@/lib/trust-passkeys";
import { computeTrustRoster } from "@/lib/trust-roster";

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
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled,
    // While a blocked session is on screen the flip to "approved" should feel
    // immediate; this matches the Access panel's open-state cadence.
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

  // Yield to the ceremony dialog the moment a pairing involving this device is
  // live — the number check renders above and replaces this card's guidance.
  const pairings = useQuery({
    queryKey: ["device-pairings", currentDevice?.id ?? null],
    queryFn: () => trust.listPairings(currentDevice?.id ?? ""),
    refetchInterval: 1500,
    enabled: show && currentDevice !== undefined,
  });
  const ceremonyLive = (pairings.data ?? []).length > 0;

  // Ask out loud, once per blocked sitting: the stamp is what makes the other
  // devices' toast surface now (and re-surface past an earlier Ignore).
  const request = useMutation({
    mutationFn: (device: { id: string; public_key: string }) =>
      browserDevices.requestApproval(device.id, device.public_key),
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
            you already use — you&apos;ll type this device&apos;s number there
            {passkey.hasBundle ? ", or sign in here with your passkey" : ""}.
          </Dialog.Description>

          <div
            className="mt-4 flex items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden />
            <span>
              {request.isSuccess
                ? "Your other devices have been asked — the number appears here once one responds."
                : "Waiting for approval…"}
            </span>
          </div>

          {passkey.status !== null && (
            <p className="mt-3 text-center text-sm font-medium" role="status">
              {passkey.status}
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
            <Button variant="ghost" className="w-full" onClick={() => router.push("/hosts")}>
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
