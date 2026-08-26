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

/** How long the approved card stays up before the sheet closes itself. */
export const APPROVED_DWELL_MS = 2_000;

type CeremonyPhase =
  | "checking"
  | "waiting"
  | "settling"
  | "pair-only"
  | "identity-blocked"
  | "done";

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
  // Which account has to do the approving. Every screen that could answer this
  // prompt is signed in as one particular account, and "approve it from one
  // this host already trusts" is unhelpful to anyone holding two — they check
  // the wrong browser, see nothing, and conclude it is broken.
  const signedInAs = me.data?.user.email ? ` as ${me.data.user.email}` : "";
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
        "The knock did not reach your other devices. Ask again, or connect a host from this phone below.",
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
  // The number check is what admits this device; the host probe below only
  // notices, and it can be a poll behind. In that gap the warning hero would be
  // contradicting a ceremony that has already succeeded — so the state between
  // a matched number and a trusted host is a wait, not an alarm.
  const checkFinished = check !== null && check.phase === "done";
  const phase: CeremonyPhase = !settled
    ? "checking"
    : phoneQuery.isError
      ? "identity-blocked"
      : target !== undefined && target.trust === "trusted"
        ? "done"
        : checkFinished
          ? "settling"
          : otherDeviceCount > 0
            ? "waiting"
            : "pair-only";

  // Approved is a full stop, not a screen to read: the surface underneath is
  // already reconnecting, and leaving the sheet up makes the operator dismiss a
  // dialog whose only news is that they can dismiss it. Long enough to see what
  // happened, short enough that it never becomes a step.
  const finished = phase === "done";
  // Through a ref, because the callers pass an inline closure: a dependency on
  // the callback itself would restart this timer on every poll-driven render
  // and the sheet would never close.
  const close = useRef(onRequestClose);
  useEffect(() => {
    close.current = onRequestClose;
  }, [onRequestClose]);
  useEffect(() => {
    if (!finished) return;
    const timer = setTimeout(() => close.current(), APPROVED_DWELL_MS);
    return () => clearTimeout(timer);
  }, [finished]);

  return (
    <View style={[styles.body, { gap: theme.space(5) }]} testID="device-approval-ceremony">
      <Card style={[styles.hero, { gap: theme.space(3) }]}>
        {phase === "checking" || phase === "settling" ? (
          <Spinner label={phase === "checking" ? "Checking device trust" : "Finishing up"} />
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
                : phase === "settling"
                  ? "Finishing up"
                  : phase === "identity-blocked"
                    ? "This device has no identity yet"
                    : phase === "waiting"
                      ? `${hostName} is waiting on your say-so`
                      : `${hostName} has not approved this device`}
          </Text>
          <Text color="mutedForeground" style={styles.centered} variant="caption">
            {phase === "done"
              ? "The terminal is reconnecting underneath."
              : phase === "settling"
                ? `The number matched. ${hostName} is picking up the approval now.`
                : phase === "identity-blocked"
                  ? "It could not register the key that hosts pin, so nothing can vouch for it yet."
                  : phase === "waiting"
                    ? `A prompt is up on every screen already signed in${signedInAs} — including your Mac's browser. Approve it from one this host already trusts and a number appears here to type there.`
                    : phase === "pair-only"
                      ? "Nothing else is signed in to answer for it. Connect a host from this phone instead."
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
            This device · {phone.label ?? "SPAWN D on iPhone"}
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
              Connect a host from this phone: run the command it gives you on the machine, then
              approve the host here. That trusts this device directly, without another one.
            </Text>
            <Button
              onPress={() => {
                onRequestClose();
                onNavigateToPairing();
              }}
              variant={phase === "pair-only" ? "default" : "outline"}
            >
              Connect a host
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
