import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { EndorsementOption } from "@/components/onboarding/endorsement-option";
import { NumberCheck } from "@/components/trust/number-check";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Divider } from "@/components/ui/divider";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { getBaseUrl } from "@/data/api/config";
import { requestDeviceApproval } from "@/data/api/endpoints/trust";
import type { BrowserEndorsementRecord } from "@/data/api/schemas/trust";
import { useDeviceHostApprovals } from "@/data/queries/device-trust";
import {
  acceptPairingEndorsement,
  serverOriginFromBaseUrl,
  useAccountDevices,
  usePendingEndorsements,
  useRegisteredPhone,
} from "@/data/queries/pairing";
import { useMeSettingsQuery } from "@/data/queries/settings";
import { qk } from "@/data/queryKeys";
import { useDeviceCeremony } from "@/data/trust/ceremony";
import { invalidateDeviceHostTrust } from "@/data/trust/device-trust";
import { haptics } from "@/lib/haptics";
import { spacing, useTheme } from "@/theme";

type CeremonyPhase = "checking" | "waiting" | "pair-only" | "identity-blocked" | "done";

/**
 * The approval ceremony, shaped for the sheet it rises in.
 *
 * One host refused this device, and the operator is mid-task: this puts the
 * knock, the number check, and the fallback in one column, ordered by how
 * likely they are to be the next thing pressed. The knock is raised the
 * moment this device has a registered identity — not gated on how many other
 * devices are visible, because the device that answers may sign in later.
 * When an approving screen answers, it opens the committed SAS ceremony
 * (mesh §4, Appendix A) toward this phone: the number appears here, the
 * human types it there, and the endorsement that lands is what admits this
 * phone. There is no look-and-click approve anywhere in this flow.
 */
export function DeviceApprovalCeremony({
  hostId,
  onRequestClose,
  onNavigateToPairing,
}: {
  hostId: string;
  /** Dismisses the presenting overlay before this component navigates away. */
  onRequestClose: () => void;
  onNavigateToPairing: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const me = useMeSettingsQuery();
  const accountId = me.data?.user.id;
  const phoneQuery = useRegisteredPhone(accountId);
  const phone = phoneQuery.data;
  const devices = useAccountDevices(phoneQuery.isSuccess);
  const endorsements = usePendingEndorsements(accountId ?? "", phone?.id ?? null);
  const approvals = useDeviceHostApprovals(true);
  const [serverOrigin, setServerOrigin] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void getBaseUrl()
      .then((baseUrl) => setServerOrigin(serverOriginFromBaseUrl(baseUrl)))
      .catch(() => setServerOrigin(null));
  }, []);

  const target = approvals.approvals.find((entry) => entry.host.id === hostId);
  const hostName = target?.host.name ?? "This host";
  const otherDeviceCount =
    devices.data?.filter((device) => device.id !== phone?.id && device.revoked_at === null)
      .length ?? 0;

  const knock = useMutation({
    mutationFn: (deviceId: string) => requestDeviceApproval(deviceId),
    onError: () =>
      setActionError(
        "The knock did not reach your other devices. Ask again, or pair with a code below.",
      ),
  });

  // Knock as soon as this device can be vouched for. The prompt this raises on
  // every other signed-in screen is the entire point of arriving here.
  const knockedFor = useRef<string | null>(null);
  const knockMutate = knock.mutate;
  const deviceId = phone?.id ?? null;
  const awaiting = target !== undefined && target.trust !== "trusted";
  // The number check, driven from here while this phone is the one being
  // approved. Polls the relay only while an approval is actually awaited.
  const ceremony = useDeviceCeremony({ accountId, self: phone, enabled: awaiting });
  const check = ceremony.ceremonies.find((view) => view.role === "new-device") ?? null;
  useEffect(() => {
    if (!awaiting || deviceId === null || knockedFor.current === deviceId) return;
    knockedFor.current = deviceId;
    knockMutate(deviceId);
  }, [awaiting, deviceId, knockMutate]);

  const accept = useMutation({
    mutationFn: (input: { record: BrowserEndorsementRecord; endorserFingerprint: string }) => {
      if (serverOrigin === null || phone === undefined || accountId === undefined) {
        throw new Error("Device trust is not ready yet.");
      }
      return acceptPairingEndorsement({
        accountId,
        serverOrigin,
        phone,
        record: input.record,
        expectedEndorserFingerprint: input.endorserFingerprint,
      });
    },
    onSuccess: () => {
      haptics.success();
      setActionError(null);
      invalidateDeviceHostTrust();
      approvals.refetch();
      void queryClient.invalidateQueries({ queryKey: qk.hosts() });
    },
    onError: (cause: unknown) => {
      haptics.error();
      setActionError(
        cause instanceof Error ? cause.message : "The introduction could not be accepted.",
      );
    },
  });

  const settled = approvals.resolved && !phoneQuery.isPending && !me.isPending;
  const phase: CeremonyPhase = !settled
    ? "checking"
    : phoneQuery.isError
      ? "identity-blocked"
      : target !== undefined && target.trust === "trusted"
        ? "done"
        : otherDeviceCount > 0
          ? "waiting"
          : "pair-only";

  return (
    <View style={[styles.body, { gap: theme.space(5) }]} testID="device-approval-ceremony">
      <Card style={[styles.hero, { gap: theme.space(3) }]}>
        {phase === "checking" ? (
          <Spinner label="Checking device trust" />
        ) : (
          <Icon
            color={
              phase === "done"
                ? "success"
                : phase === "identity-blocked"
                  ? "destructive"
                  : "warning"
            }
            name={phase === "done" ? "ShieldCheck" : "ShieldAlert"}
            size={theme.space(8)}
          />
        )}
        <View style={[styles.heroCopy, { gap: theme.space(1) }]}>
          <Text style={styles.centered} variant="label">
            {phase === "checking"
              ? "Taking stock…"
              : phase === "done"
                ? "This device is approved"
                : phase === "identity-blocked"
                  ? "This device has no identity yet"
                  : phase === "waiting"
                    ? `${hostName} is waiting on your say-so`
                    : `${hostName} has not approved this device`}
          </Text>
          <Text color="mutedForeground" style={styles.centered} variant="caption">
            {phase === "done"
              ? "The terminal is reconnecting underneath. You can close this."
              : phase === "identity-blocked"
                ? "It could not register the key that hosts pin, so nothing can vouch for it yet."
                : phase === "waiting"
                  ? "A prompt is up on every screen where you are already signed in, including your Mac's browser. Approve it from one this host already trusts and a number appears here to type there."
                  : phase === "pair-only"
                    ? "Nothing else is signed in to answer for it. Pair directly with a code from the host."
                    : ""}
          </Text>
        </View>
      </Card>

      {phase === "identity-blocked" ? (
        <View style={[styles.section, { gap: theme.space(3) }]}>
          <Text accessibilityRole="alert" color="destructive" variant="caption">
            {phoneQuery.error instanceof Error
              ? phoneQuery.error.message
              : "Device registration failed."}
          </Text>
          <Button onPress={() => void phoneQuery.refetch()} size="sm" variant="outline">
            Try again
          </Button>
        </View>
      ) : null}

      {check !== null && phase !== "done" ? (
        <NumberCheck
          entryError={ceremony.error}
          mode="show"
          number={check.number}
          onCancel={() => ceremony.cancel(check.pairingId)}
          onDone={() => {
            ceremony.dismiss(check.pairingId);
            onRequestClose();
          }}
          otherScreen="on the screen that is approving this device"
          phase={check.phase}
        />
      ) : phone && phase === "waiting" ? (
        <View style={[styles.section, { gap: theme.space(2) }]}>
          <Text color="mutedForeground" variant="sigilLabel">
            This device · {phone.label ?? "spawn on iPhone"}
          </Text>
          <View style={[styles.actionsRow, { gap: theme.space(2) }]}>
            <Button
              disabled={deviceId === null}
              loading={knock.isPending}
              onPress={() => {
                if (deviceId !== null) knockMutate(deviceId);
              }}
              size="sm"
              variant="outline"
            >
              Ask again
            </Button>
          </View>
        </View>
      ) : null}

      {actionError ? (
        <Text accessibilityRole="alert" color="destructive" variant="caption">
          {actionError}
        </Text>
      ) : null}

      {phone && (endorsements.data ?? []).length > 0 ? (
        <EndorsementOption
          acceptingKey={
            accept.variables
              ? `${accept.variables.record.host_id}:${accept.variables.record.endorser_device_id}`
              : null
          }
          onAccept={(record, endorserFingerprint) => accept.mutate({ record, endorserFingerprint })}
          onRefresh={() => void endorsements.refetch()}
          otherDeviceCount={otherDeviceCount}
          pending={endorsements.data ?? []}
          phone={phone}
          refreshing={endorsements.isFetching}
        />
      ) : null}

      {(phase === "waiting" && check === null) || phase === "pair-only" ? (
        <>
          <View style={[styles.orRow, { gap: theme.space(3) }]}>
            <Divider style={styles.orLine} />
            <Text color="mutedForeground" variant="caption">
              or
            </Text>
            <Divider style={styles.orLine} />
          </View>
          <View style={[styles.section, { gap: theme.space(2) }]}>
            <Text color="mutedForeground" style={styles.centered} variant="caption">
              Run <Text variant="mono">spawnd login</Text> on the host and enter the code it prints.
              That approves this device directly, without another one.
            </Text>
            <Button
              onPress={() => {
                onRequestClose();
                onNavigateToPairing();
              }}
              variant={phase === "pair-only" ? "default" : "outline"}
            >
              Enter a pairing code
            </Button>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actionsRow: {
    flexDirection: "row",
    justifyContent: "center",
    paddingTop: spacing[1],
  },
  body: {
    paddingBottom: spacing[6],
  },
  centered: {
    textAlign: "center",
  },
  hero: {
    alignItems: "center",
  },
  heroCopy: {
    alignItems: "center",
  },
  orLine: {
    flex: 1,
  },
  orRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  section: {
    alignItems: "center",
  },
});
