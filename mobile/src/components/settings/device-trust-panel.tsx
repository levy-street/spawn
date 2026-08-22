import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SettingsInfoRow, SettingsLinkRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { UnavailableRow } from "@/components/settings/unavailable-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Text } from "@/components/ui/text";
import { getBaseUrl } from "@/data/api/config";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import {
  useBrowserDevicesSettingsQuery,
  useEndorsementsSettingsQuery,
  useMeSettingsQuery,
  usePasskeysSettingsQuery,
  useTrustBundleSettingsQuery,
} from "@/data/queries/settings";
import { passkeyPrfCapability, probePasskeyPrfCapability } from "@/data/trust/endorsement";
import { formatHostFingerprint, type HostPin, openHostPinStore } from "@/data/trust/host-pins";
import { encodeBase64Url } from "@/lib/crypto/bytes";
import { deviceIdentity, setDeviceIdentityAccount } from "@/lib/crypto/identity";
import { spacing } from "@/theme";

export function DeviceTrustPanel(): React.JSX.Element {
  const router = useRouter();
  const me = useMeSettingsQuery();
  const devices = useBrowserDevicesSettingsQuery();
  const bundle = useTrustBundleSettingsQuery();
  const passkeys = usePasskeysSettingsQuery();
  const [identityPublicKey, setIdentityPublicKey] = useState<string | null>(null);
  const [identityFingerprint, setIdentityFingerprint] = useState<string | null>(null);
  const [pins, setPins] = useState<readonly HostPin[]>([]);
  const [storageAvailable, setStorageAvailable] = useState<boolean | null>(null);
  const [passkeyReason, setPasskeyReason] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountId = me.data?.user.id;
  const currentDevice: BrowserDeviceOut | undefined = devices.data?.find(
    (device) => device.public_key === identityPublicKey && device.revoked_at === null,
  );
  const endorsements = useEndorsementsSettingsQuery(accountId, currentDevice?.id);

  const loadLocalTrust = useCallback(async (selectedAccountId: string) => {
    setError(null);
    setDeviceIdentityAccount(selectedAccountId);
    try {
      const publicKey = await deviceIdentity.publicKey();
      if (publicKey) {
        const wire = encodeBase64Url(publicKey);
        setIdentityPublicKey(wire);
        setIdentityFingerprint(formatHostFingerprint(wire));
      } else {
        setIdentityPublicKey(null);
        setIdentityFingerprint(null);
      }
      const store = await openHostPinStore();
      const origin = new URL(await getBaseUrl()).origin;
      setPins(await store.list(selectedAccountId, origin));
      setStorageAvailable(true);
    } catch (cause) {
      setStorageAvailable(false);
      setError(cause instanceof Error ? cause.message : "Trust storage is unavailable.");
    }
  }, []);

  useEffect(() => {
    if (accountId) void loadLocalTrust(accountId);
  }, [accountId, loadLocalTrust]);

  useEffect(() => {
    void probePasskeyPrfCapability().then((capability) => setPasskeyReason(capability.reason));
  }, []);

  const activePins = pins.filter((pin) => pin.state === "active");
  const revokedPins = pins.filter((pin) => pin.state === "revoked");
  const unavailableReason = passkeyReason ?? passkeyPrfCapability.reason;

  const forgetTrust = async () => {
    if (!accountId) return;
    try {
      const store = await openHostPinStore();
      await store.clearAccount(accountId);
      setPins([]);
      setConfirmForget(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Trust storage is unavailable.");
    }
  };

  return (
    <SettingsScreen testID="device-trust-panel" title="Device trust">
      <Card variant="flat">
        <View style={styles.summary}>
          <Text variant="label">This device recognizes {activePins.length} host(s).</Text>
          <Text color="mutedForeground" variant="body">
            {bundle.data
              ? `Your saved trust opens with any of ${passkeys.data?.length ?? 0} passkey(s).`
              : `No saved trust yet — passkeys require the installed spawn build (${passkeys.data?.length ?? 0} passkeys registered).`}
          </Text>
        </View>
      </Card>

      {error ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {error}
        </Text>
      ) : null}

      <SettingsSection title="THIS DEVICE">
        <SettingsInfoRow
          hint={identityFingerprint ?? "No local Ed25519 identity is available."}
          icon="Fingerprint"
          label="Device identity"
          trailing={
            <Badge variant={identityFingerprint ? "success" : "warning"}>
              {identityFingerprint ? "ready" : "missing"}
            </Badge>
          }
        />
        <SettingsInfoRow
          hint={
            storageAvailable === false
              ? "Trust storage is unavailable. Connections are blocked."
              : "Local host pins are stored on this device and validated before connecting."
          }
          icon="Database"
          label="Trust storage"
          trailing={
            <Badge
              variant={
                storageAvailable === null ? "outline" : storageAvailable ? "success" : "destructive"
              }
            >
              {storageAvailable === null ? "checking" : storageAvailable ? "ready" : "unavailable"}
            </Badge>
          }
        />
        <SettingsInfoRow
          hint={
            currentDevice
              ? `${endorsements.data?.length ?? 0} pending endorsement introduction(s)`
              : "This identity is not registered with the server."
          }
          icon="ShieldCheck"
          label="Endorsement state"
          trailing={
            <Badge variant={currentDevice ? "info" : "warning"}>
              {currentDevice ? "registered" : "unregistered"}
            </Badge>
          }
        />
      </SettingsSection>

      <SettingsSection title="SAVED TRUST PASSKEYS">
        {!bundle.data ? (
          <UnavailableRow
            icon="KeyRound"
            label="Set up a passkey"
            reason={unavailableReason}
            testID="passkey-unavailable"
          />
        ) : null}
        <UnavailableRow
          icon="LockOpen"
          label="Unlock saved trust here"
          reason={unavailableReason}
        />
        {bundle.data ? (
          <UnavailableRow icon="KeyRound" label="Add a backup passkey" reason={unavailableReason} />
        ) : null}
        {passkeys.data?.map((passkey) => (
          <SettingsInfoRow
            hint={`Added ${new Date(passkey.created_at).toLocaleDateString()}`}
            icon="KeyRound"
            key={passkey.id}
            label={passkey.label ?? "passkey"}
            trailing={<Badge variant="outline">Revoke unavailable</Badge>}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="HOST PINS">
        {activePins.length === 0 ? (
          <EmptyState
            description="Approve this device from another trusted device, or pair a host directly."
            icon="ShieldAlert"
            title="No recognized hosts"
          />
        ) : (
          activePins.map((pin) => (
            <SettingsInfoRow
              hint={`${pin.hostIds.length} ${pin.hostIds.length === 1 ? "host ID" : "host IDs"}`}
              icon="Server"
              key={pin.hostPublicKey}
              label={pin.hostFingerprint}
              trailing={<Badge variant="success">verified</Badge>}
            />
          ))
        )}
        {revokedPins.map((pin) => (
          <SettingsInfoRow
            hint="This host identity was revoked on this device."
            icon="ShieldOff"
            key={pin.hostPublicKey}
            label={pin.hostFingerprint}
            trailing={<Badge variant="outline">revoked</Badge>}
          />
        ))}
        <Button
          disabled={pins.length === 0}
          onPress={() => setConfirmForget(true)}
          variant="outline"
        >
          Forget trust on this device
        </Button>
      </SettingsSection>

      <SettingsSection>
        <SettingsLinkRow
          hint="Pair a host directly using its eight-character code."
          icon="Plus"
          label="Connect a host"
          onPress={() => router.push("/onboarding/host")}
        />
      </SettingsSection>

      <Confirm
        confirmLabel="Forget"
        description="This removes every locally recognized host. Pair or approve this device again before connecting."
        destructive
        onCancel={() => setConfirmForget(false)}
        onConfirm={() => void forgetTrust()}
        title="Forget trust on this device?"
        visible={confirmForget}
      />
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  summary: {
    gap: spacing[2],
  },
});
