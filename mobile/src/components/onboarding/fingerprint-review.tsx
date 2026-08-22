import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { PairingCountdown } from "@/components/onboarding/pairing-countdown";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import type { PendingPairingCeremony } from "@/data/queries/pairing";
import { borderWidth, chrome, fontFamily, fontSize, lineHeight, spacing, useTheme } from "@/theme";

export interface FingerprintReviewProps {
  approving: boolean;
  ceremony: PendingPairingCeremony;
  phoneFingerprint: string;
  reapprovingRevokedPin?: boolean;
  onApprove: () => void;
  onBack: () => void;
  onExpired: () => void;
  onMismatch: () => void;
}

export function FingerprintReview({
  approving,
  ceremony,
  phoneFingerprint,
  reapprovingRevokedPin = false,
  onApprove,
  onBack,
  onExpired,
  onMismatch,
}: FingerprintReviewProps) {
  const theme = useTheme();
  const [confirmed, setConfirmed] = useState(false);

  const pinCopy = (() => {
    if (reapprovingRevokedPin) {
      return "You previously removed this host key. Approval deliberately trusts the same key again.";
    }
    if (ceremony.pinState === "active") {
      return "This exact host key is already active on this phone. Approving again only completes the server side.";
    }
    return "Approval saves this exact host key on this phone before registering it with the server.";
  })();
  const approvalLabel =
    reapprovingRevokedPin || ceremony.pinState === "active"
      ? "Approve this host again"
      : "Fingerprint matches — approve";

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" variant="title">
          Check the fingerprint for {ceremony.hostName}
        </Text>
        <Text color="mutedForeground">
          Confirm the terminal shows this exact value. If it differs, stop—the connection may be
          intercepted.
        </Text>
      </View>

      <PairingCountdown deadlineMs={ceremony.expiresAtMs} onExpired={onExpired} />

      <View
        style={[
          styles.fingerprintWell,
          {
            backgroundColor: theme.colors.muted,
            borderColor: theme.colors.border,
            borderRadius: theme.radii.lg,
          },
        ]}
      >
        <View style={styles.fingerprintHeading}>
          <Icon color="foreground" name="Fingerprint" size={spacing[5]} />
          <Text variant="label">Host fingerprint</Text>
        </View>
        <Text
          accessibilityLabel={`Host fingerprint ${ceremony.hostFingerprint}`}
          selectable
          style={styles.fingerprint}
          variant="mono"
        >
          {ceremony.hostFingerprint}
        </Text>
      </View>

      <View style={styles.phoneIdentity}>
        <View style={styles.fingerprintHeading}>
          <Icon color="mutedForeground" name="Smartphone" size={spacing[4]} />
          <Text color="mutedForeground" variant="label">
            This phone
          </Text>
        </View>
        <Text selectable style={styles.phoneFingerprint} variant="mono">
          {phoneFingerprint}
        </Text>
        <Text color="mutedForeground" variant="caption">
          After approval, the machine will print this phone fingerprint for comparison.
        </Text>
      </View>

      <View
        style={[
          styles.notice,
          {
            backgroundColor: theme.colors.warningSoft,
            borderColor: theme.colors.warning,
            borderRadius: theme.radii.md,
          },
        ]}
      >
        <Text color="warning" variant="caption">
          {pinCopy} Approval grants terminal, file, tool, and agent access on this host.
        </Text>
      </View>

      <Pressable
        accessibilityLabel="I compared the host fingerprint and it matches"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: confirmed, disabled: approving }}
        disabled={approving}
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
        <Text style={styles.confirmationCopy} weight="medium">
          I compared the host fingerprint and it matches.
        </Text>
      </Pressable>

      <Button onPress={onMismatch} variant="link">
        The fingerprint does not match
      </Button>

      <View style={styles.actions}>
        <Button disabled={approving} onPress={onBack} variant="outline">
          Back
        </Button>
        <Button
          disabled={!confirmed}
          loading={approving}
          onPress={onApprove}
          style={styles.approve}
        >
          {approvalLabel}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: spacing[2],
  },
  approve: {
    flex: 1,
  },
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
    fontFamily: fontFamily.mono,
    fontSize: fontSize.displaySm,
    lineHeight: lineHeight.lg,
    textAlign: "center",
  },
  fingerprintHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  fingerprintWell: {
    borderWidth: borderWidth.hairline,
    gap: spacing[4],
    padding: spacing[5],
  },
  heading: {
    gap: spacing[2],
  },
  notice: {
    borderWidth: borderWidth.hairline,
    padding: spacing[3],
  },
  phoneFingerprint: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.base,
    lineHeight: lineHeight.base,
  },
  phoneIdentity: {
    gap: spacing[2],
  },
});
