import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { BrowserDeviceRow } from "@/components/settings/browser-device-row";
import { SettingsBlock } from "@/components/settings/settings-block";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { listHostPins } from "@/data/api/endpoints/trust";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import type { HostOut } from "@/data/api/schemas/hosts";
import {
  useBrowserDeviceMutations,
  useBrowserDevicesSettingsQuery,
  useHostsSettingsQuery,
  useMeSettingsQuery,
} from "@/data/queries/settings";
import { qk } from "@/data/queryKeys";
import { createDeviceEndorsement } from "@/data/trust/endorsement";
import { formatHostFingerprint } from "@/data/trust/host-pins";
import { ensureDeviceRegistered, revokeThisDevice } from "@/data/trust/registration";
import { spacing, useTheme } from "@/theme";

interface HostDeviceTrust {
  host: HostOut;
  deviceIds: readonly string[];
}

function derivedDeviceFingerprint(device: BrowserDeviceOut): string {
  try {
    return formatHostFingerprint(device.public_key);
  } catch {
    return "Invalid device key";
  }
}

export function BrowserDevicesPanel(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMeSettingsQuery();
  const devices = useBrowserDevicesSettingsQuery();
  const hosts = useHostsSettingsQuery();
  const mutations = useBrowserDeviceMutations();
  const [currentDevice, setCurrentDevice] = useState<BrowserDeviceOut | null>(null);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [trustMapError, setTrustMapError] = useState<string | null>(null);
  const [hostTrust, setHostTrust] = useState<HostDeviceTrust[]>([]);
  const [approveTarget, setApproveTarget] = useState<BrowserDeviceOut | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<BrowserDeviceOut | null>(null);
  const [approvalNote, setApprovalNote] = useState<string | null>(null);
  const [revokedCurrent, setRevokedCurrent] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [busy, setBusy] = useState(false);
  const accountId = me.data?.user.id;

  const register = useCallback(async () => {
    if (!accountId) return;
    setRegistrationError(null);
    try {
      const registered = await ensureDeviceRegistered({ accountId, label: "SPAWN D on iPhone" });
      setCurrentDevice(registered);
      setRevokedCurrent(false);
      await queryClient.invalidateQueries({ queryKey: qk.browserDevices() });
    } catch (cause) {
      setRegistrationError(
        cause instanceof Error ? cause.message : "This device's identity registration failed.",
      );
    }
  }, [accountId, queryClient]);

  useEffect(() => {
    if (accountId) void register();
  }, [accountId, register]);

  useEffect(() => {
    let active = true;
    const hostList = hosts.data ?? [];
    void Promise.all(
      hostList.map(async (host) => ({ host, deviceIds: await listHostPins(host.id) })),
    ).then(
      (records) => {
        if (active) {
          setHostTrust(records);
          setTrustMapError(null);
        }
      },
      () => {
        if (active) {
          setHostTrust([]);
          setTrustMapError("Could not load host trust. Device approval is unavailable right now.");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [hosts.data]);

  const activeDevices = (devices.data ?? []).filter((device) => device.revoked_at === null);
  const revokedDevices = (devices.data ?? []).filter((device) => device.revoked_at !== null);
  const trustedCount = (deviceId: string) =>
    hostTrust.filter((record) => record.deviceIds.includes(deviceId)).length;
  const endorsableHosts = useMemo(() => {
    if (!currentDevice || !approveTarget) return [];
    return hostTrust.filter(
      ({ host, deviceIds }) =>
        host.host_public_key !== null &&
        deviceIds.includes(currentDevice.id) &&
        !deviceIds.includes(approveTarget.id),
    );
  }, [approveTarget, currentDevice, hostTrust]);

  const approve = async () => {
    if (!accountId || !currentDevice || !approveTarget) return;
    setBusy(true);
    setActionError(null);
    setApprovalNote(null);
    try {
      for (const { host } of endorsableHosts) {
        if (!host.host_public_key) continue;
        await createDeviceEndorsement({
          accountId,
          hostId: host.id,
          hostPublicKey: host.host_public_key,
          endorserDeviceId: currentDevice.id,
          endorsedDeviceId: approveTarget.id,
          endorsedPublicKey: approveTarget.public_key,
        });
      }
      const fingerprint = derivedDeviceFingerprint(approveTarget);
      setApprovalNote(
        `Approved ${approveTarget.label ?? "the device"} (${fingerprint}) for ${endorsableHosts.length} ${endorsableHosts.length === 1 ? "host" : "hosts"}. It can connect within a few seconds.`,
      );
      setApproveTarget(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not approve this device.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setBusy(true);
    setActionError(null);
    try {
      if (revokeTarget.id === currentDevice?.id) {
        await revokeThisDevice({ deviceId: revokeTarget.id });
        setCurrentDevice(null);
        setRevokedCurrent(true);
      } else {
        await mutations.revoke.mutateAsync({
          id: revokeTarget.id,
          publicKey: revokeTarget.public_key,
        });
      }
      await queryClient.invalidateQueries({ queryKey: qk.browserDevices() });
      setRevokeTarget(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Device revocation failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsScreen
      description="Every phone and browser signed in as you. A host only opens a terminal for a device it trusts."
      testID="browser-devices-panel"
      title="Browser devices"
    >
      {registrationError ? (
        <Card style={[styles.notice, { borderColor: theme.colors.destructive }]} variant="flat">
          <View style={styles.noticeHeading}>
            <Icon color="destructive" name="ShieldOff" size={spacing[5]} />
            <Text accessibilityRole="alert" style={styles.noticeTitle} variant="label">
              This device could not register its identity
            </Text>
          </View>
          <Text color="mutedForeground" variant="body">
            Terminal access and approvals are unavailable from here until it succeeds.
          </Text>
          <Text color="destructive" variant="caption">
            {registrationError}
          </Text>
          <View style={styles.actions}>
            <Button onPress={() => void register()} size="sm" variant="outline">
              Retry registration
            </Button>
          </View>
        </Card>
      ) : null}
      {revokedCurrent ? (
        <Button onPress={() => void register()} variant="outline">
          Start fresh on this device
        </Button>
      ) : null}
      {approvalNote ? (
        <Card style={[styles.notice, { borderColor: theme.colors.success }]} variant="flat">
          <View style={styles.noticeHeading}>
            <Icon color="success" name="ShieldCheck" size={spacing[5]} />
            <Text accessibilityLiveRegion="polite" style={styles.noticeTitle} variant="label">
              Device approved
            </Text>
          </View>
          <Text color="mutedForeground" variant="body">
            {approvalNote}
          </Text>
        </Card>
      ) : null}
      {devices.error || trustMapError || actionError ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {devices.error?.message ?? trustMapError ?? actionError}
        </Text>
      ) : null}

      {currentDevice && trustedCount(currentDevice.id) === 0 ? (
        <Card style={[styles.notice, { borderColor: theme.colors.warning }]} variant="flat">
          <View style={styles.noticeHeading}>
            <Icon color="warning" name="ShieldAlert" size={spacing[5]} />
            <Text style={styles.noticeTitle} variant="label">
              This device can't open terminals yet
            </Text>
          </View>
          <Text color="mutedForeground" variant="body">
            No host trusts it. Approve this fingerprint from a device that already works, or connect
            a host directly.
          </Text>
          <Text selectable variant="mono">
            {derivedDeviceFingerprint(currentDevice)}
          </Text>
          <View style={styles.actions}>
            <Button onPress={() => router.push("/device-approval")} size="sm">
              Approve this device
            </Button>
            <Button onPress={() => router.push("/onboarding/host")} size="sm" variant="outline">
              Connect a host
            </Button>
          </View>
        </Card>
      ) : null}

      {approveTarget ? (
        <Card style={[styles.notice, { borderColor: theme.colors.info }]} variant="flat">
          <View style={styles.noticeHeading}>
            <Icon color="info" name="Fingerprint" size={spacing[5]} />
            <Text style={styles.noticeTitle} variant="label">
              Approve {approveTarget.label ?? "this device"}?
            </Text>
          </View>
          <Text color="mutedForeground" variant="body">
            Compare this exact fingerprint on the other device. The name is only a label — cancel if
            the fingerprint differs.
          </Text>
          <Text selectable variant="mono">
            {derivedDeviceFingerprint(approveTarget)}
          </Text>
          <View style={styles.actions}>
            <Button
              disabled={endorsableHosts.length === 0}
              loading={busy}
              onPress={() => void approve()}
              size="sm"
            >
              {busy ? "Approving…" : "It matches, approve"}
            </Button>
            <Button onPress={() => setApproveTarget(null)} size="sm" variant="outline">
              Cancel
            </Button>
          </View>
        </Card>
      ) : null}

      <SettingsSection
        title={`Devices${activeDevices.length > 0 ? ` · ${activeDevices.length}` : ""}`}
      >
        {activeDevices.length === 0 && !devices.isPending ? (
          <EmptyState icon="MonitorSmartphone" title="No registered browsers." />
        ) : (
          activeDevices.map((device) => (
            <BrowserDeviceRow
              busy={busy || mutations.rename.isPending || mutations.revoke.isPending}
              canApprove={
                device.id !== currentDevice?.id &&
                Boolean(
                  currentDevice &&
                    hostTrust.some(
                      (record) =>
                        record.deviceIds.includes(currentDevice.id) &&
                        !record.deviceIds.includes(device.id),
                    ),
                )
              }
              current={device.id === currentDevice?.id}
              device={device}
              fingerprint={derivedDeviceFingerprint(device)}
              key={device.id}
              onApprove={() => setApproveTarget(device)}
              onRename={(label) =>
                mutations.rename.mutate(
                  { id: device.id, label },
                  { onError: (cause) => setActionError(cause.message) },
                )
              }
              onRevoke={() => setRevokeTarget(device)}
              trustedHostCount={trustedCount(device.id)}
            />
          ))
        )}
      </SettingsSection>

      {revokedDevices.length > 0 ? (
        <SettingsSection
          description="Revoked devices keep no access. This is only a record."
          title={`Revoked · ${revokedDevices.length}`}
        >
          <Button
            onPress={() => setShowRevoked((value) => !value)}
            size="sm"
            style={styles.revokedToggle}
            variant="outline"
          >
            {showRevoked ? "Hide revoked devices" : "Show revoked devices"}
          </Button>
          {showRevoked
            ? revokedDevices.map((device) => (
                <SettingsBlock key={device.id}>
                  <Text variant="label">{device.label ?? "Unnamed browser"}</Text>
                  <Text color="mutedForeground" selectable variant="mono">
                    {derivedDeviceFingerprint(device)}
                  </Text>
                </SettingsBlock>
              ))
            : null}
          {showRevoked ? (
            <Button
              loading={mutations.prune.isPending}
              onPress={() => setConfirmPrune(true)}
              size="sm"
              variant="ghost"
            >
              Clear history
            </Button>
          ) : null}
        </SettingsSection>
      ) : null}

      <Confirm
        confirmLabel="Revoke"
        description={`It immediately loses terminal access on every host. Its key fingerprint is ${
          revokeTarget ? derivedDeviceFingerprint(revokeTarget) : "—"
        }.`}
        destructive
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => void revoke()}
        title={`Revoke ${revokeTarget?.label ?? "this unnamed browser"}?`}
        visible={revokeTarget !== null}
      />
      <Confirm
        confirmLabel="Clear history"
        description="Only clears revoked devices from this list."
        destructive
        onCancel={() => setConfirmPrune(false)}
        onConfirm={() =>
          mutations.prune.mutate(undefined, {
            onSuccess: () => setConfirmPrune(false),
            onError: (cause) => setActionError(cause.message),
          })
        }
        title="Clear revoked device history?"
        visible={confirmPrune}
      />
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  notice: {
    gap: spacing[3],
  },
  noticeHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  noticeTitle: {
    flex: 1,
  },
  revokedToggle: {
    alignSelf: "flex-start",
  },
});
