import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { apiConfig } from "@/data/api/config";
import { chrome, duration, spacing, useTheme } from "@/theme";

export const DEFAULT_INSTALL_ORIGIN = "https://spawnd.dev";
export const DEFAULT_INSTALL_COMMAND = `curl -fsSL ${DEFAULT_INSTALL_ORIGIN}/install.sh | sh`;

export function installCommandForBaseUrl(baseUrl: string): string {
  if (baseUrl === apiConfig.defaultBaseUrl) return DEFAULT_INSTALL_COMMAND;
  return `curl -fsSL ${new URL(baseUrl).origin}/install.sh | sh`;
}

export interface InstallInstructionsProps {
  command?: string;
  onContinue: () => void;
  onSkip?: () => void;
}

export function InstallInstructions({
  command = DEFAULT_INSTALL_COMMAND,
  onContinue,
  onSkip,
}: InstallInstructionsProps) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyCommand = async () => {
    await Clipboard.setStringAsync(command);
    setCopied(true);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      copyTimer.current = null;
    }, duration.copyFeedback);
  };

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" variant="title">
          Connect your first host
        </Text>
        <Text color="mutedForeground">
          Install the daemon on a Mac or Linux machine, then approve its pairing code.
        </Text>
      </View>

      <View style={styles.instruction}>
        <View
          style={[
            styles.number,
            { backgroundColor: theme.colors.foreground, borderRadius: theme.radii.pill },
          ]}
        >
          <Text color="background" variant="label">
            1
          </Text>
        </View>
        <View style={styles.instructionCopy}>
          <Text weight="medium">Open Terminal on your machine</Text>
          <Text color="mutedForeground">
            On a Mac or Linux machine you control, open Terminal and run:
          </Text>
        </View>
      </View>

      <Card style={styles.commandWell} variant="flat">
        <Text selectable style={styles.command} variant="mono">
          {command}
        </Text>
        <Button
          accessibilityLabel={copied ? "Install command copied" : "Copy install command"}
          onPress={() => void copyCommand()}
          size="sm"
          variant="outline"
        >
          <Icon color="foreground" name={copied ? "Check" : "Copy"} size={spacing[4]} />
          {copied ? "Copied" : "Copy command"}
        </Button>
      </Card>

      <View style={styles.instruction}>
        <View
          style={[
            styles.number,
            { backgroundColor: theme.colors.foreground, borderRadius: theme.radii.pill },
          ]}
        >
          <Text color="background" variant="label">
            2
          </Text>
        </View>
        <View style={styles.instructionCopy}>
          <Text weight="medium">Start pairing</Text>
          <Text color="mutedForeground">After installation, run spawnd login on that machine.</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Button onPress={onContinue} style={styles.primaryAction}>
          Enter pairing code
        </Button>
        {onSkip !== undefined ? (
          <Button onPress={onSkip} variant="ghost">
            Skip for now
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing[2],
    marginTop: spacing[2],
  },
  command: {
    flexShrink: 1,
  },
  commandWell: {
    alignItems: "center",
    gap: spacing[3],
    minHeight: chrome.touchTarget,
  },
  container: {
    gap: spacing[6],
  },
  heading: {
    gap: spacing[2],
  },
  instruction: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
  },
  instructionCopy: {
    flex: 1,
    gap: spacing[1],
  },
  number: {
    alignItems: "center",
    height: spacing[7],
    justifyContent: "center",
    width: spacing[7],
  },
  primaryAction: {
    width: "100%",
  },
});
