import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ConnectionChip } from "@/components/terminal-ui/connection-status";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Menu, type MenuEntry } from "@/components/ui/menu";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import { identifyAgent } from "@/data/selectors/agent";
import type { TransportState } from "@/terminal/transport/types";
import { borderWidth, useTheme } from "@/theme";

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
  cwd: string;
  foregroundCommand: string | null;
  connectionState: TransportState;
  onDismiss: () => void;
  onRename: (name: string) => Promise<void>;
  onRestart: () => void;
  onKill: () => void;
  onUpload: () => void;
  onSearch: () => void;
  onFontSize: () => void;
  onCopyMode: () => void;
  onDiagnostics: () => void;
}

export function TerminalHeader({
  title,
  hostName,
  cwd,
  foregroundCommand,
  connectionState,
  onDismiss,
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
  const insets = useSafeAreaInsets();
  const anchorRef = useRef<View>(null);
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

  const entries: readonly MenuEntry[] = [
    {
      id: "rename",
      label: "Rename",
      icon: <Icon color="mutedForeground" name="Pencil" />,
      onPress: beginRename,
    },
    {
      id: "restart",
      label: "Restart",
      icon: <Icon color="mutedForeground" name="RotateCw" />,
      onPress: onRestart,
    },
    {
      id: "upload",
      label: "Upload file",
      icon: <Icon color="mutedForeground" name="Upload" />,
      onPress: onUpload,
    },
    {
      id: "search",
      label: "Search terminal",
      icon: <Icon color="mutedForeground" name="Search" />,
      onPress: onSearch,
    },
    {
      id: "font-size",
      label: "Font size",
      icon: <Icon color="mutedForeground" name="Type" />,
      onPress: onFontSize,
    },
    {
      id: "copy-mode",
      label: "Copy mode",
      icon: <Icon color="mutedForeground" name="Copy" />,
      onPress: onCopyMode,
    },
    {
      id: "diagnostics",
      label: "Diagnostics",
      icon: <Icon color="mutedForeground" name="Wrench" />,
      onPress: onDiagnostics,
    },
    { id: "destructive-separator", type: "separator" },
    {
      id: "kill",
      label: "Kill session",
      destructive: true,
      icon: <Icon color="destructive" name="Trash2" />,
      onPress: onKill,
    },
  ];

  return (
    <View
      style={[
        styles.header,
        {
          backgroundColor: theme.colors.background,
          borderBottomColor: theme.colors.border,
          borderBottomWidth: borderWidth.hairline,
          gap: theme.space(1),
          paddingBottom: theme.space(2),
          paddingHorizontal: theme.space(2),
          paddingTop: insets.top + theme.space(2),
        },
      ]}
      testID="terminal-header"
    >
      <View style={[styles.primaryRow, { gap: theme.space(1) }]}>
        <IconButton accessibilityLabel="Close terminal" icon="ChevronDown" onPress={onDismiss} />
        <AgentIcon identity={agentIdentity} size={theme.space(8)} />
        <View style={styles.titleColumn}>
          {renaming ? (
            <View style={[styles.renameRow, { gap: theme.space(1) }]}>
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
            <Text numberOfLines={1} variant="label" weight="semibold">
              {title}
            </Text>
          )}
          <Text color="mutedForeground" numberOfLines={1} variant="micro">
            {agent.label} · {hostName}
          </Text>
        </View>
        <ConnectionChip state={connectionState} />
        <View ref={anchorRef}>
          <IconButton
            accessibilityLabel="Terminal actions"
            icon="Ellipsis"
            onPress={() => setMenuVisible(true)}
          />
        </View>
      </View>
      <Text
        color="mutedForeground"
        numberOfLines={1}
        style={{ marginLeft: theme.space(12) }}
        variant="mono"
      >
        {cwd}
      </Text>
      <Menu
        accessibilityLabel="Terminal actions"
        align="end"
        anchorRef={anchorRef}
        entries={entries}
        onDismiss={() => setMenuVisible(false)}
        visible={menuVisible}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "column",
  },
  primaryRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  renameInput: {
    flex: 1,
  },
  renameRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  titleColumn: {
    flex: 1,
    minWidth: 0,
  },
});
