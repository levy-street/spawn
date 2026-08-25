import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { NumberCheck } from "@/components/trust/number-check";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import { denyDeviceApproval, listDeviceApprovals } from "@/data/api/endpoints/trust";
import { useDeviceHostApprovals } from "@/data/queries/device-trust";
import { useAccountDevices, useRegisteredPhone } from "@/data/queries/pairing";
import { useMeSettingsQuery } from "@/data/queries/settings";
import { qk } from "@/data/queryKeys";
import { useDeviceCeremony } from "@/data/trust/ceremony";
import { haptics } from "@/lib/haptics";
import { spacing } from "@/theme";

/**
 * The knock, answered from a phone that already works.
 *
 * Mounted once in the signed-in shell: a device asking for admission has to be
 * seen wherever the operator is looking, and the realtime layer invalidates
 * this query the moment a knock lands, so an app already open interrupts
 * itself rather than waiting for a poll.
 *
 * Renders nothing unless this device can actually help: approving means
 * signing an endorsement, which only a device some host already trusts can do.
 * Prompting a device that could only fail is worse than staying quiet.
 * Approving is the number check (mesh §4, Appendix A): this phone opens the
 * committed SAS toward the asking device, that device shows a four-digit
 * number, and the human types it here. A match signs one account-wide
 * endorsement the other device carries everywhere this phone is trusted. The
 * hosts it reaches are named, so "approve" never promises more.
 */
export function DeviceApprovalPrompt(): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const me = useMeSettingsQuery();
  const accountId = me.data?.user.id;
  const phoneQuery = useRegisteredPhone(accountId);
  const phone = phoneQuery.data;
  const devices = useAccountDevices(phoneQuery.isSuccess);
  const approvals = useDeviceHostApprovals();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [engaged, setEngaged] = useState(false);

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
  // The relay is polled only while there is something to answer.
  const ceremony = useDeviceCeremony({
    accountId,
    self: phone,
    enabled: request !== undefined || engaged,
  });
  const check = target
    ? (ceremony.ceremonies.find((view) => view.peerDeviceId === target.id) ?? null)
    : null;

  const dismiss = (requestId: string): void => {
    setError(null);
    setDismissed((current) => new Set(current).add(requestId));
  };

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
  const busy = deny.isPending || ceremony.starting;
  const label = target.label ?? "this device";

  if (check !== null) {
    return (
      <Dialog
        onDismiss={() => {
          ceremony.cancel(check.pairingId);
          setEngaged(false);
        }}
        testID="device-approval-prompt"
        title={`Approve ${label}?`}
        visible
      >
        <NumberCheck
          entryError={check.entryError ?? ceremony.error}
          mode="enter"
          number={check.number}
          onCancel={() => {
            ceremony.cancel(check.pairingId);
            setEngaged(false);
          }}
          onDone={() => {
            haptics.success();
            ceremony.dismiss(check.pairingId);
            setEngaged(false);
            dismiss(request.id);
            void queryClient.invalidateQueries({ queryKey: qk.trust() });
          }}
          onSubmit={(digits) => ceremony.submitDigits(check.pairingId, digits)}
          otherScreen={`on ${label}`}
          phase={check.phase}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      onDismiss={() => dismiss(request.id)}
      testID="device-approval-prompt"
      title={`Approve ${label}?`}
      visible
    >
      <View style={styles.body}>
        <Text color="mutedForeground" variant="body">
          It signed in to your account. It cannot open anything on your hosts until you approve it
          here.
        </Text>
        <Text variant="body">
          To approve it, type the number it shows on its screen. The number only appears there, so
          nobody can approve a device they are not holding.
        </Text>
        <Text color="mutedForeground" variant="caption">
          This approval covers{" "}
          <Text variant="caption">
            {formatHostList(endorsableHosts.map((entry) => entry.host.name))}
          </Text>
          . Any other host will ask again from a screen it already trusts.
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
          <Button
            disabled={busy}
            loading={ceremony.starting}
            onPress={() => {
              setError(null);
              setEngaged(true);
              ceremony.start(target);
            }}
          >
            Enter its number
          </Button>
        </View>
      </View>
    </Dialog>
  );
}

/** "dream", "dream and minivac", "dream, minivac and 3 more". */
function formatHostList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
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
});
