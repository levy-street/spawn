"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type BrowserDevice, browserDevices, hosts, trust } from "@/lib/api";
import {
  createBrowserEndorsementProof,
  loadBrowserDeviceIdentity,
} from "@/lib/browser-device-identity";
import { ed25519PublicKeyFingerprint } from "@/lib/signed-signal";

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

/**
 * The endorsement ceremony, inline. The fingerprint comparison is the entire
 * security value: signing proves this device vouched for a key, but only the
 * operator seeing the same fingerprint on both screens proves the key belongs
 * to the device they think it does. Everything security-relevant here is
 * preserved from the original /trust flow: the endorsed fingerprint is
 * re-derived locally from the key (a server-substituted key is refused), and
 * the endorsement covers every host this endorsing device is trusted by.
 */
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
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);

  const endorse = useMutation({
    mutationFn: async () => {
      const identity = await loadBrowserDeviceIdentity(accountId);
      if (identity === null) {
        throw new Error("This browser has no identity to approve with.");
      }
      const registered = await browserDevices.list();
      const mine = registered.find((device) => device.public_key === identity.publicKeyWire);
      if (mine === undefined) {
        throw new Error("This browser is not registered with the server.");
      }
      // Mesh R9: chain-capable hosts refuse per-host device endorsements (the
      // add-device ceremony covers them account-wide), so this legacy path only
      // targets hosts that have not advertised chain support.
      const keyed = (await hosts.list()).filter(
        (host) => (host.host_public_key ?? null) !== null && !host.supports_account_chains,
      );
      const myHostIds = new Set<string>();
      for (const host of keyed) {
        if ((await trust.hostPins(host.id)).includes(mine.id)) myHostIds.add(host.id);
      }
      const targets = keyed.filter((host) => myHostIds.has(host.id));
      if (targets.length === 0) {
        throw new Error(
          "Every host you can vouch toward accepts account-wide trust — use “Add a device to your account” above instead of per-host approval.",
        );
      }
      // The fingerprint the operator compared is only meaningful if it is the
      // fingerprint of the key being signed. Re-derive and refuse on mismatch
      // so a hostile server cannot pair the victim's fingerprint with its own
      // key and harvest a signature over the attacker key.
      const derived = await ed25519PublicKeyFingerprint(target.public_key);
      if (derived !== targetFingerprint || derived !== target.fingerprint) {
        throw new Error(
          "This device's fingerprint does not match its key. Refusing to approve — the server may be substituting a key.",
        );
      }
      let count = 0;
      for (const host of targets) {
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
        count += 1;
      }
      return { count, fingerprint: derived };
    },
    onMutate: () => setFailure(null),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["trust"] });
      onDone(
        `Approved ${target.label ?? "the device"} (${result.fingerprint}) for ${result.count} host${
          result.count === 1 ? "" : "s"
        }. It can connect within a few seconds.`,
      );
    },
    onError: (error) => setFailure(error instanceof Error ? error.message : String(error)),
  });

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
          onClick={() => endorse.mutate()}
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
