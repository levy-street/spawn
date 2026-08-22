import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import type { PairingFailure, PairingFailureKind } from "@/data/queries/pairing";
import { borderWidth, spacing, useTheme } from "@/theme";

interface FailureCopy {
  title: string;
  description: string;
  action: string;
}

const FAILURE_COPY: Record<PairingFailureKind, FailureCopy> = {
  "fingerprint-mismatch": {
    title: "Fingerprints do not match",
    description:
      "Connection blocked. Recheck the code on the machine and explicitly review its fingerprint again.",
    action: "Enter a new code",
  },
  "identity-missing": {
    title: "Phone identity is missing",
    description: "Set up this phone in Device trust before approving a host.",
    action: "Try device setup again",
  },
  "identity-revoked": {
    title: "Phone identity was revoked",
    description: "This device cannot approve hosts. Start fresh from Device trust settings.",
    action: "Back to pairing",
  },
  "identity-storage-unavailable": {
    title: "Phone identity storage is unavailable",
    description: "Secure identity storage could not be read. Host approval is blocked.",
    action: "Try again",
  },
  "pin-revoked": {
    title: "This host identity was revoked",
    description:
      "Reapprove only after checking the host fingerprint against the value on the machine.",
    action: "Review this key again",
  },
  "pin-storage-unavailable": {
    title: "Trust storage is unavailable",
    description: "The host pin store could not be read. Host approval is blocked.",
    action: "Try again",
  },
  "pairing-expired": {
    title: "Pairing code expired",
    description: "Run spawnd login on the machine to create a new code, then start again.",
    action: "Enter a new code",
  },
  "unknown-code": {
    title: "Code not found",
    description: "Check the eight characters shown by spawnd login and try again.",
    action: "Try another code",
  },
  "host-not-ready": {
    title: "Host proof is still pending",
    description: "Wait for spawnd login to finish preparing the code, then retry.",
    action: "Retry lookup",
  },
  "approval-incomplete": {
    title: "Server approval did not complete",
    description:
      "The exact host fingerprint is saved locally, but server approval did not complete. Retry the same reviewed approval or enter a new code.",
    action: "Retry approval",
  },
  "endorsement-invalid": {
    title: "Endorsement could not be verified",
    description: "The trusted-device introduction was invalid or changed. No host key was saved.",
    action: "Refresh endorsements",
  },
  "pairing-rejected": {
    title: "Host approval was blocked",
    description: "The reviewed host could not be approved. Check the machine and try again.",
    action: "Try again",
  },
};

export interface TrustFailureStateProps {
  failure: PairingFailure;
  onAction: () => void;
  onRestart?: () => void;
}

export function TrustFailureState({ failure, onAction, onRestart }: TrustFailureStateProps) {
  const theme = useTheme();
  const copy = FAILURE_COPY[failure.kind];

  return (
    <View style={styles.container} testID={`trust-failure-${failure.kind}`}>
      <View
        style={[
          styles.icon,
          {
            backgroundColor: theme.colors.destructiveSoft,
            borderColor: theme.colors.destructive,
            borderRadius: theme.radii.xl,
          },
        ]}
      >
        <Icon color="destructive" name="ShieldAlert" size={spacing[6]} />
      </View>
      <View style={styles.copy}>
        <Text accessibilityRole="header" style={styles.centered} variant="title">
          {copy.title}
        </Text>
        <Text color="mutedForeground" style={styles.centered}>
          {copy.description}
        </Text>
        {failure.detail !== undefined ? (
          <Text color="destructive" style={styles.centered} variant="caption">
            {failure.detail}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        <Button onPress={onAction}>{copy.action}</Button>
        {onRestart !== undefined ? (
          <Button onPress={onRestart} variant="ghost">
            Enter a new code
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing[2],
    width: "100%",
  },
  centered: {
    textAlign: "center",
  },
  container: {
    alignItems: "center",
    gap: spacing[5],
    paddingVertical: spacing[8],
  },
  copy: {
    gap: spacing[2],
  },
  icon: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    height: spacing[12],
    justifyContent: "center",
    width: spacing[12],
  },
});
