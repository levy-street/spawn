import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Divider } from "@/components/ui/divider";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import type { BrowserEndorsementRecord } from "@/data/api/schemas/trust";
import { passkeyPrfCapability } from "@/data/trust/endorsement";
import { formatHostFingerprint } from "@/data/trust/host-pins";
import { borderWidth, chrome, fontSize, spacing, useTheme } from "@/theme";

export interface EndorsementOptionProps {
  acceptingKey: string | null;
  otherDeviceCount: number;
  pending: readonly BrowserEndorsementRecord[];
  phone: BrowserDeviceOut;
  refreshing: boolean;
  onAccept: (record: BrowserEndorsementRecord, endorserFingerprint: string) => void;
  onRefresh: () => void;
}

function recordKey(record: BrowserEndorsementRecord): string {
  return `${record.host_id}:${record.endorser_device_id}`;
}

function EndorsementReview({
  accepting,
  record,
  onAccept,
}: {
  accepting: boolean;
  record: BrowserEndorsementRecord;
  onAccept: (fingerprint: string) => void;
}) {
  const theme = useTheme();
  const [confirmed, setConfirmed] = useState(false);
  let endorserFingerprint: string | null = null;
  let hostFingerprint: string | null = null;
  try {
    endorserFingerprint = formatHostFingerprint(record.endorser_public_key);
    hostFingerprint = formatHostFingerprint(record.host_public_key);
  } catch {
    endorserFingerprint = null;
    hostFingerprint = null;
  }

  if (endorserFingerprint === null || hostFingerprint === null) {
    return (
      <Text accessibilityRole="alert" color="destructive">
        This endorsement contains an unreadable identity and cannot be accepted.
      </Text>
    );
  }

  return (
    <View style={styles.review}>
      <View style={styles.reviewHeading}>
        <Icon color="foreground" name="ShieldCheck" size={spacing[5]} />
        <View style={styles.reviewHeadingCopy}>
          <Text weight="semibold">{record.host_name}</Text>
          <Text color="mutedForeground" variant="caption">
            Host {hostFingerprint}
          </Text>
        </View>
      </View>
      <Text color="mutedForeground">
        Compare this fingerprint with the trusted device named below.
      </Text>
      <Card style={styles.fingerprintWell} variant="flat">
        <Text color="mutedForeground" variant="caption">
          {record.endorser_label ?? "Trusted device"}
        </Text>
        <Text selectable style={styles.fingerprint} variant="mono">
          {endorserFingerprint}
        </Text>
      </Card>
      <Pressable
        accessibilityLabel="I compared the trusted device fingerprint"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: confirmed, disabled: accepting }}
        disabled={accepting}
        onPress={() => setConfirmed((value) => !value)}
        style={styles.confirmation}
      >
        <View
          style={[
            styles.checkbox,
            {
              backgroundColor: confirmed ? theme.colors.foreground : theme.colors.background,
              borderColor: confirmed ? theme.colors.foreground : theme.colors.border,
              borderRadius: theme.radii.sm,
            },
          ]}
        >
          {confirmed ? <Icon color="background" name="Check" size={spacing[4]} /> : null}
        </View>
        <Text style={styles.confirmationCopy}>The trusted device fingerprint matches.</Text>
      </Pressable>
      <Button
        disabled={!confirmed}
        loading={accepting}
        onPress={() => onAccept(endorserFingerprint)}
      >
        Accept trusted introduction
      </Button>
    </View>
  );
}

export function EndorsementOption({
  acceptingKey,
  otherDeviceCount,
  pending,
  phone,
  refreshing,
  onAccept,
  onRefresh,
}: EndorsementOptionProps) {
  if (otherDeviceCount === 0 && pending.length === 0) return null;

  return (
    <View style={styles.container}>
      <Divider />
      <View style={styles.heading}>
        <Text variant="title">Use another trusted device</Text>
        <Text color="mutedForeground">
          Approve this phone from a device that already connects to your hosts, then refresh here.
        </Text>
      </View>

      <View style={styles.phoneIdentity}>
        <Text color="mutedForeground" variant="caption">
          This phone
        </Text>
        <Text selectable style={styles.phoneFingerprint} variant="mono">
          {phone.fingerprint}
        </Text>
      </View>

      {pending.length === 0 ? (
        <Button loading={refreshing} onPress={onRefresh} variant="outline">
          Refresh endorsements
        </Button>
      ) : (
        <View style={styles.pending}>
          {pending.map((record) => {
            const key = recordKey(record);
            return (
              <EndorsementReview
                accepting={acceptingKey === key}
                key={key}
                onAccept={(fingerprint) => onAccept(record, fingerprint)}
                record={record}
              />
            );
          })}
        </View>
      )}

      <Text color="mutedForeground" variant="caption">
        {passkeyPrfCapability.reason}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  checkbox: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    height: spacing[6],
    justifyContent: "center",
    width: spacing[6],
  },
  confirmation: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    minHeight: chrome.touchTarget,
  },
  confirmationCopy: {
    flex: 1,
  },
  container: {
    gap: spacing[5],
  },
  fingerprint: {
    fontSize: fontSize.base,
  },
  fingerprintWell: {
    gap: spacing[2],
  },
  heading: {
    gap: spacing[2],
  },
  pending: {
    gap: spacing[6],
  },
  phoneFingerprint: {
    fontSize: fontSize.base,
  },
  phoneIdentity: {
    gap: spacing[1],
  },
  review: {
    gap: spacing[4],
  },
  reviewHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  reviewHeadingCopy: {
    flex: 1,
    gap: spacing[1],
  },
});
