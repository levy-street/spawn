import { useMemo, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppHeader, type AppHeaderAction } from "@/components/layout/app-header";
import { ConnectionChip } from "@/components/terminal-ui/connection-status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativePopover, type NativePopoverProps } from "@/components/ui/native-popover";
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
  onBack: () => void;
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
  foregroundCommand,
  connectionState,
  onBack,
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
  const { width } = useWindowDimensions();
  const [menuVisible, setMenuVisible] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(title);
  const [saving, setSaving] = useState(false);
  const agent = inferAgentPresentation(foregroundCommand);

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

  // AppHeader owns this geometry; using the same tokens keeps the popover anchored to its action.
  const actionAnchor = useMemo<NativePopoverProps["anchor"]>(
    () => ({
      x: width - insets.right - sizing.appHeader.horizontalPadding - sizing.appHeader.actionTarget,
      y: insets.top + (sizing.appHeader.minHeight - sizing.appHeader.actionTarget) / 2,
      width: sizing.appHeader.actionTarget,
      height: sizing.appHeader.actionTarget,
    }),
    [insets.right, insets.top, width],
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

  const actions: readonly AppHeaderAction[] = [
    {
      accessibilityLabel: "Terminal actions",
      icon: "Ellipsis",
      onPress: () => setMenuVisible(true),
      testID: "terminal-header-menu-button",
    },
  ];

  return (
    <>
      <AppHeader
        accessory={<ConnectionChip state={connectionState} />}
        actions={actions}
        onBack={onBack}
        subtitle={`${agent.label} · ${hostName}`}
        testID="terminal-header"
        title={title}
      />
      <NativePopover
        anchor={actionAnchor}
        items={items}
        onDismiss={() => setMenuVisible(false)}
        visible={menuVisible}
      />
      <Dialog
        footer={
          <>
            <Button
              disabled={saving}
              onPress={() => setRenaming(false)}
              size="sm"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={draftName.trim().length === 0}
              loading={saving}
              onPress={() => void saveRename()}
              size="sm"
            >
              Save
            </Button>
          </>
        }
        onDismiss={() => {
          if (!saving) setRenaming(false);
        }}
        showCloseButton={false}
        size="sm"
        title="Rename session"
        visible={renaming}
      >
        <View
          style={{
            gap: theme.space(2),
            paddingHorizontal: theme.space(4),
            paddingVertical: theme.space(2),
          }}
        >
          <Input
            accessibilityLabel="Session name"
            autoFocus
            editable={!saving}
            onChangeText={setDraftName}
            onSubmitEditing={() => void saveRename()}
            purpose="name"
            returnKeyType="done"
            selectTextOnFocus
            value={draftName}
          />
        </View>
      </Dialog>
    </>
  );
}
