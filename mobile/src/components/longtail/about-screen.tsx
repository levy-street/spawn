import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { useEffect, useRef, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";

import { BrandMark } from "@/components/brand/brand-mark";
import {
  DOWNLOAD_URL,
  installCommandsForBaseUrl,
  SECURITY_URL,
  SOURCE_URL,
} from "@/components/longtail/public-content";
import { SettingsBlock } from "@/components/settings/settings-block";
import { SettingsLinkRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import { getBaseUrl } from "@/data/api/config";
import { presentShareSheet } from "@/lib/share";
import { borderWidth, duration, spacing, useTheme } from "@/theme";

const PUBLIC_FALLBACK_ORIGIN = "https://spawnd.dev";

type CopiedCommand = "standard" | "windows" | "prebuilt" | null;

export interface AboutScreenProps {
  baseUrl?: string;
  version?: string;
}

export function AboutScreen({ baseUrl, version }: AboutScreenProps): React.JSX.Element {
  const theme = useTheme();
  const toast = useToast();
  const [resolvedBaseUrl, setResolvedBaseUrl] = useState(baseUrl ?? PUBLIC_FALLBACK_ORIGIN);
  const [copied, setCopied] = useState<CopiedCommand>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appVersion = version ?? Constants.expoConfig?.version ?? "Unknown";
  const commands = installCommandsForBaseUrl(resolvedBaseUrl);

  useEffect(() => {
    if (baseUrl !== undefined) {
      setResolvedBaseUrl(baseUrl);
      return;
    }
    let active = true;
    void getBaseUrl().then(
      (value) => {
        if (active) setResolvedBaseUrl(value);
      },
      () => {
        if (active) setResolvedBaseUrl(PUBLIC_FALLBACK_ORIGIN);
      },
    );
    return () => {
      active = false;
    };
  }, [baseUrl]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyCommand = async (kind: Exclude<CopiedCommand, null>, command: string) => {
    try {
      await Clipboard.setStringAsync(command);
      setCopied(kind);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        setCopied(null);
        copyTimer.current = null;
      }, duration.copyFeedback);
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;
      toast.error("Could not copy the install command", detail ? { detail } : undefined);
    }
  };

  const shareInstructions = async () => {
    try {
      await presentShareSheet({
        message: `Install spawnd on a Mac or Linux machine you control:\n\n${commands.standard}\n\nAfter installation, run spawnd possess on that machine.`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;
      toast.error("Could not share the install instructions", detail ? { detail } : undefined);
    }
  };

  const openExternal = async (label: string, url: string) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;
      toast.error(`Could not open ${label}`, detail ? { detail } : undefined);
    }
  };

  return (
    <SettingsScreen testID="about-screen" title="About & security">
      <SettingsSection>
        <SettingsBlock>
          <View style={styles.identity}>
            <View style={[styles.mark, { backgroundColor: theme.colors.brandAccentSoft }]}>
              <BrandMark
                accessibilityLabel="SPAWN D"
                color={theme.colors.brandAccent}
                size={spacing[6]}
                testID="about-brand-mark"
              />
            </View>
            <View style={styles.identityCopy}>
              <Text variant="title">SPAWN D</Text>
              <Text color="mutedForeground" variant="caption">
                Version {appVersion}
              </Text>
            </View>
            <Badge variant="outline">MIT / Apache-2.0</Badge>
          </View>
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection title="Security">
        <SettingsBlock>
          <Text variant="label">The server cannot read your terminal</Text>
          <Text color="mutedForeground">We introduce. We never listen.</Text>
          <Text color="mutedForeground" variant="caption">
            Terminal traffic is encrypted directly between this device and your host. The control
            plane carries signaling, while visible fingerprints, explicit pairing, revocation, and
            encrypted TURN fallback preserve the server-as-adversary threat model.
          </Text>
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection
        description="Install spawnd on a Mac, Linux, or Windows machine you control."
        title="Install a host"
      >
        <SettingsBlock>
          <Text variant="label">Install command</Text>
          <View
            style={[
              styles.commandWell,
              {
                backgroundColor: theme.colors.muted,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.md,
              },
            ]}
          >
            <Text selectable variant="mono">
              {commands.standard}
            </Text>
          </View>
          <View style={styles.commandActions}>
            <Button
              accessibilityLabel="Copy install command"
              onPress={() => void copyCommand("standard", commands.standard)}
              size="sm"
              variant="outline"
            >
              <Icon
                color="foreground"
                name={copied === "standard" ? "Check" : "Copy"}
                size={spacing[4]}
              />
              {copied === "standard" ? "Copied" : "Copy command"}
            </Button>
            <Button onPress={() => void shareInstructions()} size="sm" variant="outline">
              <Icon color="foreground" name="Send" size={spacing[4]} />
              Share
            </Button>
          </View>
        </SettingsBlock>

        <SettingsBlock>
          <Text variant="label">Windows (via WSL)</Text>
          <View
            style={[
              styles.commandWell,
              {
                backgroundColor: theme.colors.muted,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.md,
              },
            ]}
          >
            <Text selectable variant="mono">
              {commands.windows}
            </Text>
          </View>
          <Button
            accessibilityLabel="Copy Windows install command"
            onPress={() => void copyCommand("windows", commands.windows)}
            size="sm"
            variant="outline"
          >
            <Icon
              color="foreground"
              name={copied === "windows" ? "Check" : "Copy"}
              size={spacing[4]}
            />
            {copied === "windows" ? "Copied" : "Copy command"}
          </Button>
        </SettingsBlock>

        <SettingsBlock>
          <Text variant="label">Prebuilt-only smoke test</Text>
          <View
            style={[
              styles.commandWell,
              {
                backgroundColor: theme.colors.muted,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.md,
              },
            ]}
          >
            <Text selectable variant="mono">
              {commands.prebuiltOnly}
            </Text>
          </View>
          <Button
            accessibilityLabel="Copy prebuilt-only command"
            onPress={() => void copyCommand("prebuilt", commands.prebuiltOnly)}
            size="sm"
            variant="outline"
          >
            <Icon
              color="foreground"
              name={copied === "prebuilt" ? "Check" : "Copy"}
              size={spacing[4]}
            />
            {copied === "prebuilt" ? "Copied" : "Copy command"}
          </Button>
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection title="Links">
        <SettingsLinkRow
          accessibilityHint="Opens the SPAWN D security page in your browser"
          icon="ShieldCheck"
          label="Security"
          onPress={() => void openExternal("Security", SECURITY_URL)}
        />
        <SettingsLinkRow
          accessibilityHint="Opens host download information in your browser"
          icon="Download"
          label="Download & install"
          onPress={() => void openExternal("Download & install", DOWNLOAD_URL)}
        />
        <SettingsLinkRow
          accessibilityHint="Opens the source repository in your browser"
          icon="ExternalLink"
          label="Open source"
          onPress={() => void openExternal("Open source", SOURCE_URL)}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  commandActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  commandWell: {
    borderWidth: borderWidth.hairline,
    padding: spacing[3],
  },
  identity: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  identityCopy: {
    flex: 1,
    gap: spacing[1],
  },
  mark: {
    alignItems: "center",
    borderRadius: spacing[2.5],
    height: spacing[11],
    justifyContent: "center",
    width: spacing[11],
  },
});
