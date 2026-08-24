import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import { denyDeviceApproval, listDeviceApprovals } from "@/data/api/endpoints/trust";
import { useDeviceHostApprovals } from "@/data/queries/device-trust";
import { useAccountDevices, useRegisteredPhone } from "@/data/queries/pairing";
import { useMeSettingsQuery } from "@/data/queries/settings";
import { qk } from "@/data/queryKeys";
import { createDeviceEndorsement } from "@/data/trust/endorsement";
import { formatHostFingerprint } from "@/data/trust/host-pins";
import { haptics } from "@/lib/haptics";
import { fontSize, spacing } from "@/theme";

/**
 * The knock, answered from a phone that already works.
 *
 * Mounted once in the signed-in shell: a device asking for admission has to be
 * seen wherever the operator is looking, and the realtime layer invalidates
 * this query the moment a knock lands, so an app already open interrupts
 * itself rather than waiting for a poll.
 *
 * Renders nothing unless this device can actually help — approving means
 * signing an endorsement, which only a device some host already trusts can do.
 * Prompting a device that could only fail is worse than staying quiet.
 */
export function DeviceApprovalPrompt(): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const me = useMeSettingsQuery();
  const accountId = me.data?.user.id;
  const phoneQuery = useRegisteredPhone(accountId ?? "");
  const phone = phoneQuery.data;
  const devices = useAccountDevices(phoneQuery.isSuccess);
  const approvals = useDeviceHostApprovals();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const pending = useQuery({
    queryKey: qk.deviceApprovals(),
    queryFn: listDeviceApprovals,
    enabled: accountId !== undefined,
    // The socket is the fast path; this is the floor under a dropped frame.
    refetchInterval: 60_000,
  });

  const request = (pending.data ?? []).find(
    (candidate) =>
      !dismissed.has(candidate.id) &&
      // Never prompt a device about itself: the asking device sees its own
      // wizard, and it cannot vouch for itself in any case.
      candidate.browser_device_id !== phone?.id,
  );
  const target = (devices.data ?? []).find(
    (device) => device.id === request?.browser_device_id && device.revoked_at === null,
  );
  // Hosts that trust this device are exactly the ones it can vouch for.
  const endorsableHosts = approvals.approved.filter((entry) => entry.host.host_public_key !== null);

  const dismiss = (requestId: string): void => {
    setError(null);
    setDismissed((current) => new Set(current).add(requestId));
  };

  const approve = useMutation({
    mutationFn: async (): Promise<number> => {
      if (!accountId || !phone || !target || !request) {
        throw new Error("Device approval is not ready.");
      }
      // The fingerprint the operator compared is only meaningful if it is the
      // fingerprint of the key being signed. Re-derive it locally and refuse
      // on mismatch, so a substituted key cannot harvest a signature.
      const derived = formatHostFingerprint(target.public_key);
      if (derived !== request.fingerprint) {
        throw new Error(
          "This device's fingerprint does not match its key. The server may be substituting a key.",
        );
      }
      for (const { host } of endorsableHosts) {
        if (host.host_public_key === null) continue;
        await createDeviceEndorsement({
          accountId,
          hostId: host.id,
          hostPublicKey: host.host_public_key,
          endorserDeviceId: phone.id,
          endorsedDeviceId: target.id,
          endorsedPublicKey: target.public_key,
        });
      }
      return endorsableHosts.length;
    },
    onSuccess: () => {
      haptics.success();
      if (request) dismiss(request.id);
      void queryClient.invalidateQueries({ queryKey: qk.trust() });
    },
    onError: (cause: unknown) => {
      haptics.error();
      setError(cause instanceof Error ? cause.message : "This device could not be approved.");
    },
  });

  const deny = useMutation({
    mutationFn: (requestId: string) => denyDeviceApproval(requestId),
    onSuccess: (_result, requestId) => {
      dismiss(requestId);
      void queryClient.invalidateQueries({ queryKey: qk.trust() });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "The request could not be denied.");
    },
  });

  if (!request || !target || endorsableHosts.length === 0) return null;
  const busy = approve.isPending || deny.isPending;

  return (
    <Dialog
      onDismiss={() => dismiss(request.id)}
      testID="device-approval-prompt"
      title={`${target.label ?? "A device"} wants to connect`}
      visible
    >
      <View style={styles.body}>
        <Text color="mutedForeground" variant="body">
          It signed in to your account and cannot open anything until a device you already trust
          vouches for it.
        </Text>
        <Text variant="body">Check that the asking device shows exactly this fingerprint:</Text>
        <Text selectable style={styles.fingerprint} variant="mono">
          {request.fingerprint}
        </Text>
        <Text color="mutedForeground" variant="caption">
          The name is a label anyone can set — only a matching fingerprint proves you are trusting
          the device you think you are. If it differs, deny.
        </Text>
        {error ? (
          <Text accessibilityRole="alert" color="destructive" variant="caption">
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button disabled={busy} onPress={() => deny.mutate(request.id)} variant="outline">
            Deny
          </Button>
          <Button loading={approve.isPending} disabled={busy} onPress={() => approve.mutate()}>
            It matches — approve
          </Button>
        </View>
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: spacing[2],
    justifyContent: "flex-end",
  },
  body: {
    gap: spacing[3],
  },
  fingerprint: {
    fontSize: fontSize.base,
  },
});
