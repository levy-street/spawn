import { Stack } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from "react-native";

import { ConnectionChip } from "@/components/terminal-ui/connection-status";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { NativePopover, type NativePopoverProps } from "@/components/ui/native-popover";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import { identifyAgent } from "@/data/selectors/agent";
import type { TransportState } from "@/terminal/transport/types";
import { useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface AgentPresentation {
  label: string;
}

export function inferAgentPresentation(command: string | null): AgentPresentation {
  const normalized = command?.toLowerCase() ?? "";
  if (normalized.includes("claude")) return { label: "Claude Code" };
  if (normalized.includes("codex")) return { label: "Codex" };
  if (normalized.includes("opencode")) return { label: "OpenCode" };
  if (normalized.includes("aider")) return { label: "Aider" };
  return { label: "Shell" };
}

export interface TerminalHeaderProps {
  title: string;
  hostName: string;
  foregroundCommand: string | null;
  connectionState: TransportState;
  onRename: (name: string) => Promise<void>;
  onRestart: () => void;
  onKill: () => void;
  onUpload: () => void;
  onSearch: () => void;
  onFontSize: () => void;
  onCopyMode: () => void;
  onDiagnostics: () => void;
}

const EMPTY_ANCHOR: NativePopoverProps["anchor"] = {
  x: 0,
  y: 0,
  width: sizing.control.minimumTouchTarget,
  height: sizing.control.minimumTouchTarget,
};

export function TerminalHeader({
  title,
  hostName,
  foregroundCommand,
  connectionState,
  onRename,
  onRestart,
  onKill,
  onUpload,
  onSearch,
  onFontSize,
  onCopyMode,
  onDiagnostics,
}: TerminalHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const anchorRef = useRef<View>(null);
  const [anchor, setAnchor] = useState(EMPTY_ANCHOR);
  const [menuVisible, setMenuVisible] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(title);
  const [saving, setSaving] = useState(false);
  const agent = inferAgentPresentation(foregroundCommand);
  const agentIdentity = identifyAgent(foregroundCommand, []);

  const beginRename = (): void => {
    setDraftName(title);
    setRenaming(true);
  };

  const saveRename = async (): Promise<void> => {
    const name = draftName.trim();
    if (name.length === 0 || saving) return;
    setSaving(true);
    try {
      await onRename(name);
      setRenaming(false);
    } finally {
      setSaving(false);
    }
  };

  const measureAnchor = useCallback((): void => {
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
    });
  }, []);

  const handleAnchorLayout = useCallback(
    (event: LayoutChangeEvent): void => {
      setAnchor(event.nativeEvent.layout);
      measureAnchor();
    },
    [measureAnchor],
  );

  const items: NativePopoverProps["items"] = [
    { key: "rename", label: "Rename", icon: "pencil", onPress: beginRename },
    { key: "restart", label: "Restart", icon: "arrow.clockwise", onPress: onRestart },
    { key: "upload", label: "Upload file", icon: "square.and.arrow.up", onPress: onUpload },
    { key: "search", label: "Search terminal", icon: "magnifyingglass", onPress: onSearch },
    { key: "font-size", label: "Font size", icon: "textformat.size", onPress: onFontSize },
    { key: "copy-mode", label: "Copy mode", icon: "doc.on.doc", onPress: onCopyMode },
    {
      key: "diagnostics",
      label: "Diagnostics",
      icon: "wrench.and.screwdriver",
      onPress: onDiagnostics,
    },
    {
      key: "kill",
      label: "Kill session",
      icon: "trash",
      destructive: true,
      onPress: onKill,
    },
  ];

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View
              collapsable={false}
              onLayout={handleAnchorLayout}
              ref={anchorRef}
              testID="terminal-header-menu-anchor"
            >
              <Pressable
                accessibilityLabel="Terminal actions"
                accessibilityRole="button"
                onPress={() => {
                  measureAnchor();
                  setMenuVisible(true);
                }}
                style={({ pressed }) => [
                  styles.action,
                  {
                    backgroundColor: pressed ? theme.colors.accent : "transparent",
                    borderRadius: theme.radii.md,
                  },
                ]}
                testID="terminal-header-menu-button"
              >
                <Icon
                  name="Ellipsis"
                  size={sizing.control.icon}
                  symbol="ellipsis"
                  variant="chrome"
                />
              </Pressable>
            </View>
          ),
          headerShown: true,
          headerTitle: () =>
            renaming ? (
              <View style={[styles.renameRow, { gap: sizing.space.peer }]}>
                <Input
                  accessibilityLabel="Session name"
                  autoFocus
                  containerStyle={styles.renameInput}
                  editable={!saving}
                  onChangeText={setDraftName}
                  onSubmitEditing={() => void saveRename()}
                  purpose="name"
                  returnKeyType="done"
                  selectTextOnFocus
                  value={draftName}
                />
                <IconButton
                  accessibilityLabel="Save session name"
                  disabled={draftName.trim().length === 0 || saving}
                  icon="Check"
                  loading={saving}
                  onPress={() => void saveRename()}
                  size="sm"
                />
                <IconButton
                  accessibilityLabel="Cancel rename"
                  disabled={saving}
                  icon="X"
                  onPress={() => setRenaming(false)}
                  size="sm"
                />
              </View>
            ) : (
              <View
                style={[styles.headerTitle, { gap: sizing.space.cluster }]}
                testID="terminal-header"
              >
                <AgentIcon identity={agentIdentity} size={sizing.listRow.leading.glyph} />
                <View style={styles.titleColumn}>
                  <View
                    style={[styles.titleLine, { gap: sizing.space.peer }]}
                    testID="terminal-header-title-line"
                  >
                    <Text numberOfLines={1} style={styles.title} variant="label" weight="semibold">
                      {title}
                    </Text>
                    <ConnectionChip state={connectionState} />
                  </View>
                  <Text color="mutedForeground" numberOfLines={1} variant="micro">
                    {agent.label} · {hostName}
                  </Text>
                </View>
              </View>
            ),
          title,
        }}
      />
      <NativePopover
        anchor={anchor}
        items={items}
        onDismiss={() => setMenuVisible(false)}
        visible={menuVisible}
      />
    </>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    height: sizing.control.minimumTouchTarget,
    justifyContent: "center",
    width: sizing.control.minimumTouchTarget,
  },
  headerTitle: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    minWidth: 0,
  },
  renameInput: {
    flex: 1,
  },
  renameRow: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
  },
  title: {
    flexShrink: 1,
  },
  titleColumn: {
    flexShrink: 1,
    minWidth: 0,
  },
  titleLine: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: sizing.type.cardTitle.lineHeight,
  },
});
