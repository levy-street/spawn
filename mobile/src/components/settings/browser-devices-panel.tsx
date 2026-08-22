import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { BrowserDeviceRow } from "@/components/settings/browser-device-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
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
import { spacing } from "@/theme";

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
      const registered = await ensureDeviceRegistered({ accountId, label: "iPhone" });
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
      description="Devices signed in to your account. A new device needs approval from one that already works before hosts will accept it."
      testID="browser-devices-panel"
      title="Browser devices"
    >
      {registrationError ? (
        <Card variant="flat">
          <View style={styles.notice}>
            <Text accessibilityRole="alert" variant="label">
              This device's identity registration failed. Terminal access and approvals are
              unavailable from here until it succeeds.
            </Text>
            <Text color="destructive" variant="caption">
              {registrationError}
            </Text>
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
        <Text accessibilityLiveRegion="polite" variant="body">
          {approvalNote}
        </Text>
      ) : null}
      {devices.error || trustMapError || actionError ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {devices.error?.message ?? trustMapError ?? actionError}
        </Text>
      ) : null}

      {currentDevice && trustedCount(currentDevice.id) === 0 ? (
        <Card variant="flat">
          <View style={styles.notice}>
            <Text variant="label">This device can't open terminals yet</Text>
            <Text color="mutedForeground" selectable variant="mono">
              {derivedDeviceFingerprint(currentDevice)}
            </Text>
            <Text color="mutedForeground" variant="body">
              Open Browser devices on a working device and approve this fingerprint, or connect a
              host directly.
            </Text>
            <Button onPress={() => router.push("/onboarding/host")} size="sm" variant="outline">
              Connect a host
            </Button>
          </View>
        </Card>
      ) : null}

      <SettingsSection>
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

      {approveTarget ? (
        <Card variant="flat">
          <View style={styles.notice}>
            <Text variant="label">Approve {approveTarget.label ?? "this device"}?</Text>
            <Text color="mutedForeground" variant="body">
              Compare this exact fingerprint on the target device. The name is only a mutable label.
              Cancel if the fingerprint differs.
            </Text>
            <Text selectable variant="mono">
              {derivedDeviceFingerprint(approveTarget)}
            </Text>
            <View style={styles.actions}>
              <Button
                disabled={endorsableHosts.length === 0}
                loading={busy}
                onPress={() => void approve()}
              >
                {busy ? "Approving…" : "It matches — approve"}
              </Button>
              <Button onPress={() => setApproveTarget(null)} variant="secondary">
                Cancel
              </Button>
            </View>
          </View>
        </Card>
      ) : null}

      {revokedDevices.length > 0 ? (
        <SettingsSection>
          <Button onPress={() => setShowRevoked((value) => !value)} variant="ghost">
            Revoked devices ({revokedDevices.length})
          </Button>
          {showRevoked
            ? revokedDevices.map((device) => (
                <Card key={device.id} variant="flat">
                  <Text variant="label">{device.label ?? "Unnamed browser"}</Text>
                  <Text color="mutedForeground" selectable variant="mono">
                    {derivedDeviceFingerprint(device)}
                  </Text>
                </Card>
              ))
            : null}
          {showRevoked ? (
            <Button
              loading={mutations.prune.isPending}
              onPress={() => setConfirmPrune(true)}
              size="sm"
              variant="outline"
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
        description="Revocation stays permanent. This only removes revoked devices from this list."
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
});
