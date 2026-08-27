import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import {
  DEFAULT_INSTALL_TARGETS,
  type InstallTarget,
  type InstallTargetId,
} from "@/components/longtail/public-content";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { presentShareSheet } from "@/lib/share";
import { chrome, duration, spacing, useTheme } from "@/theme";

export interface InstallInstructionsProps {
  defaultTargetId?: InstallTargetId;
  onCommandCopied?: () => void;
  onSkip?: () => void;
  targets?: readonly InstallTarget[];
}

function defaultInstallTarget(): InstallTarget {
  const target = DEFAULT_INSTALL_TARGETS.find((candidate) => candidate.id === "unix");
  if (target === undefined) throw new Error("The default install target is unavailable.");
  return target;
}

export function InstallInstructions({
  defaultTargetId = "unix",
  onCommandCopied,
  onSkip,
  targets = DEFAULT_INSTALL_TARGETS,
}: InstallInstructionsProps) {
  const theme = useTheme();
  const [activeTargetId, setActiveTargetId] = useState<InstallTargetId>(defaultTargetId);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTarget =
    targets.find((target) => target.id === activeTargetId) ?? targets[0] ?? defaultInstallTarget();

  useEffect(() => {
    if (targets.some((target) => target.id === activeTargetId)) return;
    const fallback =
      targets.find((target) => target.id === defaultTargetId) ??
      targets[0] ??
      defaultInstallTarget();
    setActiveTargetId(fallback.id);
  }, [activeTargetId, defaultTargetId, targets]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyCommand = async () => {
    await Clipboard.setStringAsync(activeTarget.command);
    onCommandCopied?.();
    setCopied(true);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      copyTimer.current = null;
    }, duration.copyFeedback);
  };

  const shareCommand = async () => {
    await presentShareSheet({ message: activeTarget.command });
    onCommandCopied?.();
  };

  return (
    <View style={styles.container}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" variant="title">
          Connect your first host
        </Text>
        <Text color="mutedForeground">
          Install the daemon on a machine you control, then approve it from the link spawnd possess
          prints. It appears here once it's online.
        </Text>
      </View>

      <View style={styles.targetChoice}>
        <Text color="mutedForeground">Choose the computer you're installing on.</Text>
        <SegmentedControl<InstallTargetId>
          accessibilityLabel="Host operating system"
          onChange={(targetId) => {
            setActiveTargetId(targetId);
            setCopied(false);
          }}
          options={targets.map((target) => ({ label: target.label, value: target.id }))}
          testID="install-target"
          value={activeTarget.id}
        />
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
          <Text weight="medium">{activeTarget.stepHeading}</Text>
          <Text color="mutedForeground">{activeTarget.stepDescription}</Text>
        </View>
      </View>

      <Card style={styles.commandWell} variant="flat">
        <View
          accessibilityLabel={activeTarget.commandAccessibilityLabel}
          style={styles.commandLine}
        >
          <Text color="mutedForeground" variant="mono">
            {activeTarget.prompt}
          </Text>
          <Text selectable style={styles.command} variant="mono">
            {activeTarget.command}
          </Text>
        </View>
        <View style={styles.commandActions}>
          <Button
            accessibilityLabel={copied ? "Install command copied" : "Copy install command"}
            onPress={() => void copyCommand()}
            size="sm"
            variant="outline"
          >
            <Icon color="foreground" name={copied ? "Check" : "Copy"} size={spacing[4]} />
            {copied ? "Copied" : "Copy command"}
          </Button>
          <Button
            accessibilityLabel="Share install command"
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
        Already running SPAWN D for another account on that machine? Run spawnd possess
        --new-account instead.
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
    flex: 1,
    flexShrink: 1,
  },
  commandActions: {
    flexDirection: "row",
    gap: spacing[2],
  },
  commandLine: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[2],
    width: "100%",
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
  targetChoice: {
    gap: spacing[2],
  },
});
