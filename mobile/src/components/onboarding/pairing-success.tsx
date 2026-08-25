import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { borderWidth, chrome, fontSize, spacing, useTheme } from "@/theme";

export interface PairingSuccessProps {
  hostName: string;
  phoneFingerprint: string;
  onConfirmed: () => void;
  onMismatch: () => void;
  onPairAnother: () => void;
}

export function PairingSuccess({
  hostName,
  phoneFingerprint,
  onConfirmed,
  onMismatch,
  onPairAnother,
}: PairingSuccessProps) {
  const theme = useTheme();
  const [matches, setMatches] = useState(false);
  const [complete, setComplete] = useState(false);

  if (complete) {
    return (
      <EmptyState
        action={
          <Button onPress={onPairAnother} variant="outline">
            Connect another host
          </Button>
        }
        description={`${hostName} is connected. It will appear as soon as its daemon comes online.`}
        icon="ShieldCheck"
        title="Host approved"
      />
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" variant="title">
          Compare this phone on the machine
        </Text>
        <Text color="mutedForeground">
          spawnd possess now prints the approving phone fingerprint. Confirm it shows this exact
          value.
        </Text>
      </View>
      <Card style={styles.fingerprintWell} variant="flat">
        <View style={styles.fingerprintHeading}>
          <Icon color="foreground" name="Smartphone" size={spacing[5]} />
          <Text variant="label">This phone</Text>
        </View>
        <Text selectable style={styles.fingerprint} variant="mono">
          {phoneFingerprint}
        </Text>
      </Card>
      <Pressable
        accessibilityLabel="The machine shows this phone fingerprint"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: matches }}
        onPress={() => setMatches((value) => !value)}
        style={styles.confirmation}
      >
        <View
          style={[
            styles.checkbox,
            {
              backgroundColor: matches ? theme.colors.foreground : theme.colors.background,
              borderColor: matches ? theme.colors.foreground : theme.colors.border,
              borderRadius: theme.radii.sm,
            },
          ]}
        >
          {matches ? <Icon color="background" name="Check" size={spacing[4]} /> : null}
        </View>
        <Text style={styles.confirmationCopy} weight="medium">
          The machine shows this phone fingerprint.
        </Text>
      </Pressable>
      <Button onPress={onMismatch} variant="link">
        The phone fingerprint does not match
      </Button>
      <Button
        disabled={!matches}
        onPress={() => {
          onConfirmed();
          setComplete(true);
        }}
      >
        Comparison complete
      </Button>
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
    fontSize: fontSize.displaySm,
    textAlign: "center",
  },
  fingerprintHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  fingerprintWell: {
    gap: spacing[4],
  },
  heading: {
    gap: spacing[2],
  },
});
