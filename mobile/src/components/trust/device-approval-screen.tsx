import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { EndorsementOption } from "@/components/onboarding/endorsement-option";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
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
import { invalidateDeviceHostTrust } from "@/data/trust/device-trust";
import { haptics } from "@/lib/haptics";
import { fontSize, spacing } from "@/theme";

/**
 * The one screen that answers "why can't this device open anything, and what do
 * I press?".
 *
 * A host answers only devices whose key it has pinned, and nothing here can
 * mint that pin: it has to be signed on a device the host already trusts. So
 * this screen's job is to *ask* — it raises a knock the account's other devices
 * see as a prompt — and then to notice the moment the answer lands.
 */
export function DeviceApprovalScreen({
  hostId,
}: {
  /** Narrows the copy to the host the operator was actually trying to open. */
  hostId?: string;
}): React.JSX.Element {
  const router = useRouter();
  return (
    <Screen header={<AppHeader onBack={() => router.back()} title="Approve this device" />} scroll>
      <DeviceApprovalBody {...(hostId === undefined ? {} : { hostId })} />
    </Screen>
  );
}

/**
 * The body without a screen frame, so setup can present the same ceremony as a
 * step rather than duplicating it.
 */
export function DeviceApprovalBody({ hostId }: { hostId?: string }): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMeSettingsQuery();
  const accountId = me.data?.user.id;
  const phoneQuery = useRegisteredPhone(accountId ?? "");
  const phone = phoneQuery.data;
  const devicesQuery = useAccountDevices(phoneQuery.isSuccess);
  const endorsements = usePendingEndorsements(accountId ?? "", phone?.id ?? null);
  const approvals = useDeviceHostApprovals(true);
  const [serverOrigin, setServerOrigin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void getBaseUrl()
      .then((baseUrl) => setServerOrigin(serverOriginFromBaseUrl(baseUrl)))
      .catch(() => setServerOrigin(null));
  }, []);

  const target =
    hostId === undefined
      ? undefined
      : approvals.approvals.find((entry) => entry.host.id === hostId);
  const settled = approvals.resolved && !phoneQuery.isPending;
  const done = settled && (target ? target.trust === "trusted" : approvals.awaiting.length === 0);
  const otherDeviceCount =
    devicesQuery.data?.filter((device) => device.id !== phone?.id && device.revoked_at === null)
      .length ?? 0;
  const waiting = settled && !done && otherDeviceCount > 0;

  const knock = useMutation({
    mutationFn: (deviceId: string) => requestDeviceApproval(deviceId),
    onError: () =>
      setError(
        "Could not tell your other devices that this one is waiting. Approve it from one of them, or use a pairing code below.",
      ),
  });

  // Raise the knock as soon as this device is registered and known to need one.
  // The prompt it produces elsewhere is what turns "go find the setting" into
  // "press approve", so asking is the entire point of arriving here.
  const knockedFor = useRef<string | null>(null);
  const knockMutate = knock.mutate;
  const deviceId = phone?.id ?? null;
  useEffect(() => {
    if (!waiting || deviceId === null || knockedFor.current === deviceId) return;
    knockedFor.current = deviceId;
    knockMutate(deviceId);
  }, [deviceId, knockMutate, waiting]);

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
      setError(null);
      invalidateDeviceHostTrust();
      approvals.refetch();
      void queryClient.invalidateQueries({ queryKey: qk.hosts() });
    },
    onError: (cause: unknown) => {
      haptics.error();
      setError(cause instanceof Error ? cause.message : "The introduction could not be accepted.");
    },
  });

  const copyFingerprint = async (): Promise<void> => {
    if (!phone) return;
    await Clipboard.setStringAsync(phone.fingerprint);
    haptics.success();
    setCopied(true);
  };

  return (
    <View style={styles.body} testID="device-approval-screen">
      <Card variant="flat">
        <View style={styles.status}>
          {settled && !waiting ? (
            <Icon
              color={done ? "success" : "warning"}
              name={done ? "ShieldCheck" : "ShieldAlert"}
              size={spacing[6]}
            />
          ) : (
            <Spinner />
          )}
          <View style={styles.statusCopy}>
            <Text variant="label">
              {!settled
                ? "Checking which hosts trust this device…"
                : done
                  ? "This device is approved"
                  : waiting
                    ? "Waiting for approval"
                    : target
                      ? `${target.host.name} has not approved this device`
                      : "No host has approved this device yet"}
            </Text>
            <Text color="mutedForeground" variant="caption">
              {done
                ? "You can go back and open a terminal. This screen keeps watching in case that changes."
                : waiting
                  ? "Open spawn on a device that already works — a prompt is waiting for you there. This screen notices the moment you approve."
                  : "A host only answers devices whose key it has pinned, and no other device is registered to vouch for this one. Use a pairing code below."}
            </Text>
          </View>
        </View>
      </Card>

      {error ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {error}
        </Text>
      ) : null}

      <View style={styles.section}>
        <SectionHeader title="THIS DEVICE" />
        <Card variant="flat">
          <View style={styles.identity}>
            <Text color="mutedForeground" variant="caption">
              {phone?.label ?? "This device"}
            </Text>
            <Text selectable style={styles.fingerprint} variant="mono">
              {phone?.fingerprint ?? "…"}
            </Text>
            <Text color="mutedForeground" variant="caption">
              The approving device shows a fingerprint too. They must match — that comparison is the
              whole of what makes this safe.
            </Text>
            <Button
              disabled={!phone}
              onPress={() => void copyFingerprint()}
              size="sm"
              variant="outline"
            >
              {copied ? "Copied" : "Copy fingerprint"}
            </Button>
          </View>
        </Card>
      </View>

      {waiting ? (
        <View style={styles.section}>
          <SectionHeader title="ON YOUR OTHER DEVICE" />
          <Card variant="flat">
            <View style={styles.steps}>
              <Text color="mutedForeground" variant="body">
                1. Open spawn there, signed in to this same account.
              </Text>
              <Text color="mutedForeground" variant="body">
                2. A prompt appears asking whether to let {phone?.label ?? "this device"} connect.
              </Text>
              <Text color="mutedForeground" variant="body">
                3. Check its fingerprint matches the one above, then press Approve.
              </Text>
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
          </Card>
        </View>
      ) : null}

      {phone && (endorsements.data ?? []).length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="WAITING FOR YOU" />
          <EndorsementOption
            acceptingKey={
              accept.variables
                ? `${accept.variables.record.host_id}:${accept.variables.record.endorser_device_id}`
                : null
            }
            onAccept={(record, endorserFingerprint) =>
              accept.mutate({ record, endorserFingerprint })
            }
            onRefresh={() => void endorsements.refetch()}
            otherDeviceCount={otherDeviceCount}
            pending={endorsements.data ?? []}
            phone={phone}
            refreshing={endorsements.isFetching}
          />
        </View>
      ) : null}

      {settled && !done ? (
        <View style={styles.section}>
          <SectionHeader title="OR PAIR FROM THIS DEVICE" />
          <Card variant="flat">
            <View style={styles.steps}>
              <Text color="mutedForeground" variant="body">
                Run <Text variant="mono">spawnd login</Text> on the host and enter the code it
                prints. That approves this device directly, without another one.
              </Text>
              <Button onPress={() => router.push("/onboarding/host")} variant="outline">
                Enter a pairing code
              </Button>
            </View>
          </Card>
        </View>
      ) : null}

      {approvals.approvals.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="HOSTS" />
          <Card variant="flat">
            {approvals.approvals.map((entry) => (
              <ListRow
                key={entry.host.id}
                subtitle={
                  entry.trust === "trusted"
                    ? "Approved for this device"
                    : entry.trust === "untrusted"
                      ? "Has not approved this device"
                      : "Approval state unavailable"
                }
                title={entry.host.name}
                trailing={
                  <Badge
                    variant={
                      entry.trust === "trusted"
                        ? "success-soft"
                        : entry.trust === "untrusted"
                          ? "warning-soft"
                          : "outline"
                    }
                  >
                    {entry.trust === "trusted"
                      ? "approved"
                      : entry.trust === "untrusted"
                        ? "waiting"
                        : "unknown"}
                  </Badge>
                }
              />
            ))}
          </Card>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing[5],
  },
  fingerprint: {
    fontSize: fontSize.base,
  },
  identity: {
    alignItems: "flex-start",
    gap: spacing[2],
  },
  section: {
    gap: spacing[2],
  },
  status: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  statusCopy: {
    flex: 1,
    gap: spacing[1],
  },
  steps: {
    alignItems: "flex-start",
    gap: spacing[2],
  },
});
