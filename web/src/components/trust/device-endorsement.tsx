"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type BrowserDevice, browserDevices, hosts, trust } from "@/lib/api";
import {
  createAccountEndorsementProof,
  createBrowserEndorsementProof,
  loadBrowserDeviceIdentity,
} from "@/lib/browser-device-identity";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";
import { hostsTrustingDevice } from "@/lib/trust-roster";

/**
 * Advisory trust coverage: which hosts already accept which browser devices.
 * Server data, so it is used for badges and flow routing only — never as
 * verification. Refetches on an interval so a device waiting for approval
 * flips to "trusted" on its own once the endorsement lands.
 */
export function useDeviceTrustMap(enabled: boolean) {
  const hostList = useQuery({
    queryKey: ["trust", "hosts"],
    queryFn: () => hosts.list(),
    enabled,
  });
  const keyedHosts = (hostList.data ?? []).filter(
    (host) => (host.host_public_key ?? null) !== null,
  );
  const pins = useQuery({
    queryKey: ["trust", "host-pin-map", keyedHosts.map((host) => host.id).join(",")],
    queryFn: async () => {
      const entries = await Promise.all(
        keyedHosts.map(async (host) => [host.id, await trust.hostPins(host.id)] as const),
      );
      const byDevice = new Map<string, string[]>();
      for (const [hostId, deviceIds] of entries) {
        for (const deviceId of deviceIds) {
          byDevice.set(deviceId, [...(byDevice.get(deviceId) ?? []), hostId]);
        }
      }
      return { byDevice, byHost: new Map(entries) };
    },
    enabled: enabled && keyedHosts.length > 0,
    refetchInterval: 15_000,
  });
  return {
    keyedHosts,
    hostsById: new Map(keyedHosts.map((host) => [host.id, host])),
    trustedHostIdsFor: (deviceId: string): string[] => pins.data?.byDevice.get(deviceId) ?? [],
    /** Live pin device-ids per host, for R5 sole-trust warnings and the roster. */
    pinsByHost: pins.data?.byHost ?? new Map<string, string[]>(),
    /** Devices holding at least one per-host pin: the roster's advisory anchors. */
    pinnedDeviceIds: new Set(pins.data ? pins.data.byDevice.keys() : []),
    ready: pins.data !== undefined || keyedHosts.length === 0,
  };
}

/** The account's endorsement edges, for coverage and carried chains. */
export function useAccountEndorsementEdges(enabled: boolean) {
  return useQuery({
    queryKey: ["trust", "account-endorsements"],
    queryFn: () => trust.accountEndorsements(),
    enabled,
    refetchInterval: 15_000,
  });
}

export interface EndorsementResult {
  /** Hosts this approval covers — where the device can connect next. */
  count: number;
  hostNames: string[];
  fingerprint: string;
}

/**
 * The endorsement ceremony itself, shared by the Devices panel and the
 * approval prompt.
 *
 * The security-relevant part is the fingerprint re-derivation: the operator
 * compared a fingerprint on two screens, and that comparison only means
 * anything if the key being signed is the key that fingerprint describes. A
 * server that pairs the victim's fingerprint with its own key gets a refusal,
 * not a signature.
 *
 * What gets signed depends on the hosts this browser can vouch toward:
 * - toward a host that validates account chains (mesh §3, every current
 *   daemon), ONE account-scoped endorsement — this browser → the device — which
 *   the device carries on its offers and every such host anchored on (or
 *   chained to) this browser accepts;
 * - toward a host still on the per-host path, one per-host endorsement each,
 *   exactly as before (a chain-capable host refuses these — mesh R9).
 * The account edge is one-directional on purpose: the operator verified the
 * asking device's key, not the other way round, so no reverse edge is signed
 * (the mutual edge of the SAS ceremony would let a key this browser never
 * checked reach hosts anchored on the new device).
 */
export function useEndorseDevice(
  accountId: string,
  onSuccess?: (result: EndorsementResult, target: BrowserDevice) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      target: BrowserDevice;
      /** Locally derived by the caller — never the server's claim. */
      targetFingerprint: string;
    }): Promise<EndorsementResult> => {
      const { target, targetFingerprint } = input;
      const identity = await loadBrowserDeviceIdentity(accountId);
      if (identity === null) {
        throw new Error("This browser has no identity to approve with.");
      }
      const registered = await browserDevices.list();
      const mine = registered.find((device) => device.public_key === identity.publicKeyWire);
      if (mine === undefined) {
        throw new Error("This browser is not registered with the server.");
      }
      // The fingerprint the operator compared is only meaningful if it is the
      // fingerprint of the key being signed. Re-derive and refuse on mismatch
      // so a hostile server cannot pair the victim's fingerprint with its own
      // key and harvest a signature over the attacker key. (The server serves
      // no fingerprint of its own to disagree with — mesh B5.)
      const derived = await ed25519PublicKeyFingerprint(target.public_key);
      if (derived !== targetFingerprint) {
        throw new Error(
          "This device's fingerprint does not match its key. Refusing to approve — the server may be substituting a key.",
        );
      }
      const keyed = (await hosts.list()).filter((host) => (host.host_public_key ?? null) !== null);
      const pinsByHost = new Map(
        await Promise.all(
          keyed.map(async (host) => [host.id, await trust.hostPins(host.id)] as const),
        ),
      );
      const edges = await trust.accountEndorsements();
      const covered = hostsTrustingDevice(mine.id, keyed, pinsByHost, registered, edges);
      if (covered.length === 0) {
        throw new Error(
          "No host trusts this browser yet, so it cannot vouch for another device. Approve from a device that already works.",
        );
      }
      const chainHosts = covered.filter((host) => host.supports_account_chains);
      const legacyHosts = covered.filter((host) => !host.supports_account_chains);
      if (chainHosts.length > 0) {
        const signature = await createAccountEndorsementProof(
          identity,
          accountId,
          target.public_key,
          target.id,
        );
        await trust.createAccountEndorsement({
          endorser_device_id: mine.id,
          endorsed_device_id: target.id,
          signature,
        });
      }
      for (const host of legacyHosts) {
        const signature = await createBrowserEndorsementProof(
          identity,
          accountId,
          host.host_public_key as string,
          target.public_key,
          target.id,
        );
        await trust.endorse({
          host_id: host.id,
          endorser_device_id: mine.id,
          endorsed_device_id: target.id,
          signature,
        });
      }
      return {
        count: covered.length,
        hostNames: covered.map((host) => host.name),
        fingerprint: derived,
      };
    },
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["trust"] });
      onSuccess?.(result, variables.target);
    },
  });
}

export function EndorseDevicePanel({
  accountId,
  target,
  targetFingerprint,
  onDone,
  onCancel,
}: {
  accountId: string;
  target: BrowserDevice;
  /** Locally derived by the caller (never the server's claim). */
  targetFingerprint: string;
  onDone: (summary: string) => void;
  onCancel: () => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const endorse = useEndorseDevice(accountId, (result) =>
    onDone(
      `Approved ${target.label ?? "the device"} (${result.fingerprint}) for ${result.count} host${
        result.count === 1 ? "" : "s"
      }. It can connect within a few seconds.`,
    ),
  );

  return (
    <div
      className="mt-2 space-y-2 rounded-md border border-border bg-muted/40 p-3"
      data-testid="endorse-panel"
    >
      <p className="text-sm">
        On <span className="font-medium">{target.label ?? "the new device"}</span>, open Settings →
        Browser devices and check that its row shows exactly this fingerprint:
      </p>
      <p className="break-all rounded bg-muted px-2 py-1.5 font-mono text-sm font-semibold">
        {targetFingerprint}
      </p>
      <p className="text-xs text-muted-foreground">
        The name is just a label anyone can set — only a matching fingerprint proves you are
        trusting the right device. If it differs, cancel.
      </p>
      {failure !== null && (
        <p className="text-sm text-destructive" role="alert">
          {failure}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={endorse.isPending}
          onClick={() => {
            setFailure(null);
            endorse.mutate(
              { target, targetFingerprint },
              {
                onError: (error) =>
                  setFailure(error instanceof Error ? error.message : String(error)),
              },
            );
          }}
        >
          {endorse.isPending ? "Approving…" : "It matches — approve"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={endorse.isPending}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
