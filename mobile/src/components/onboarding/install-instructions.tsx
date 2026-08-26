import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { apiConfig } from "@/data/api/config";
import { presentShareSheet } from "@/lib/share";
import { chrome, duration, spacing, useTheme } from "@/theme";

export const DEFAULT_INSTALL_ORIGIN = "https://spawnd.dev";
export const DEFAULT_INSTALL_COMMAND = `curl -fsSL ${DEFAULT_INSTALL_ORIGIN}/install.sh | sh`;

export function installCommandForBaseUrl(baseUrl: string, setupToken?: string): string {
  const command =
    baseUrl === apiConfig.defaultBaseUrl
      ? DEFAULT_INSTALL_COMMAND
      : `curl -fsSL ${new URL(baseUrl).origin}/install.sh | sh`;
  return setupToken === undefined ? command : `${command} -s -- --setup ${setupToken}`;
}

export interface InstallInstructionsProps {
  command?: string;
  onCommandCopied?: () => void;
  onSkip?: () => void;
  preparing?: boolean;
}

export function InstallInstructions({
  command = DEFAULT_INSTALL_COMMAND,
  onCommandCopied,
  onSkip,
  preparing = false,
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
    onCommandCopied?.();
    setCopied(true);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      copyTimer.current = null;
    }, duration.copyFeedback);
  };

  const shareCommand = async () => {
    await presentShareSheet({ message: command });
    onCommandCopied?.();
  };

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" variant="title">
          Connect your first host
        </Text>
        <Text color="mutedForeground">
          Install the daemon on a Mac or Linux machine. When it registers, its approval appears
          here.
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
        <View style={styles.commandActions}>
          <Button
            accessibilityLabel={copied ? "Install command copied" : "Copy install command"}
            disabled={preparing}
            loading={preparing}
            onPress={() => void copyCommand()}
            size="sm"
            variant="outline"
          >
            <Icon color="foreground" name={copied ? "Check" : "Copy"} size={spacing[4]} />
            {copied ? "Copied" : "Copy command"}
          </Button>
          <Button
            accessibilityLabel="Share install command"
            disabled={preparing}
            onPress={() => void shareCommand()}
            size="sm"
            variant="outline"
          >
            <Icon color="foreground" name="Send" size={spacing[4]} />
            Share
          </Button>
        </View>
      </Card>
      <Text color="mutedForeground" variant="caption">
        Already running SPAWN D for another account on that machine? Add --new-account.
      </Text>

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
          <Text color="mutedForeground">
            After installation, run spawnd possess on that machine.
          </Text>
        </View>
      </View>

      {onSkip !== undefined ? (
        <View style={styles.actions}>
          <Button onPress={onSkip} variant="ghost">
            Skip for now
          </Button>
        </View>
      ) : null}
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
  commandActions: {
    flexDirection: "row",
    gap: spacing[2],
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
});
