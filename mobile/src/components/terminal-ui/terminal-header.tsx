import { useState } from "react";
import { View } from "react-native";

import { AppHeader, type AppHeaderAction } from "@/components/layout/app-header";
import { agentKindFor, agentLabel } from "@/components/terminal-ui/terminal-commands";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Menu, type MenuEntry } from "@/components/ui/menu";
import { commandBasename } from "@/data/selectors/agent";
import type { ConnectionInfo } from "@/terminal/transport/types";
import { useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

function menuIcon(name: IconName, destructive = false): React.JSX.Element {
  return (
    <Icon
      color={destructive ? "destructive" : "popoverForeground"}
      name={name}
      size={sizing.control.icon}
    />
  );
}

export interface AgentPresentation {
  label: string;
}

/**
 * What the subtitle calls whatever is running. The same reading decides which
 * key list the strip above the keyboard offers, so both come from one place —
 * an unrecognised agent keeps its own command name rather than being filed as a
 * shell, which is what it used to read as.
 */
export function inferAgentPresentation(command: string | null): AgentPresentation {
  const kind = agentKindFor(command);
  if (kind === "agent") return { label: commandBasename(command) ?? agentLabel(kind) };
  return { label: agentLabel(kind) };
}

export interface TerminalHeaderProps {
  title: string;
  hostName: string;
  /** The folder this window points at; shown on the control that re-points it. */
  cwd: string;
  foregroundCommand: string | null;
  connectionInfo?: ConnectionInfo | null;
  onBack: () => void;
  onRename: (name: string) => Promise<void>;
  /** Re-point this window: pick a folder, or pick what runs in it. */
  onChangeFolder: () => void;
  onSwitchAgent: () => void;
  onRestart: () => void;
  /** What restarting brings back — the agent resumed, or a login shell. */
  restartDetail?: string;
  onKill: () => void;
  onUpload: () => void;
  onSearch: () => void;
  onFontSize: () => void;
  onCopyMode: () => void;
  onDiagnostics: () => void;
  /** Reported so the screen can stand the keyboard down under the menu. */
  onMenuVisibilityChange?: (visible: boolean) => void;
}

export function TerminalHeader({
  title,
  hostName,
  cwd,
  foregroundCommand,
  connectionInfo,
  onBack,
  onRename,
  onChangeFolder,
  onSwitchAgent,
  onRestart,
  restartDetail,
  onKill,
  onUpload,
  onSearch,
  onFontSize,
  onCopyMode,
  onDiagnostics,
  onMenuVisibilityChange,
}: TerminalHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const [menuVisible, setMenuVisible] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(title);
  const [saving, setSaving] = useState(false);
  const agent = inferAgentPresentation(foregroundCommand);
  const path = connectionInfo
    ? `${connectionInfo.kind}${connectionInfo.rttMs === null ? "" : ` · ${connectionInfo.rttMs} ms`}`
    : null;

  const showMenu = (visible: boolean): void => {
    setMenuVisible(visible);
    onMenuVisibilityChange?.(visible);
  };

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

  // The same drawer rows every other menu in the app presents through, so the
  // terminal's actions are the size of an action rather than of a list line.
  const entries: readonly MenuEntry[] = [
    { id: "rename", label: "Rename", icon: menuIcon("Pencil"), onPress: beginRename },
    // Where the window points and what runs in it — the two things the desktop
    // pane header lets you change after the fact, and the reason the launcher
    // no longer asks for either up front.
    {
      id: "switch-agent",
      label: "Change agent",
      detail: `Now running ${agent.label}`,
      icon: menuIcon("Bot"),
      onPress: onSwitchAgent,
    },
    {
      id: "change-folder",
      label: "Change folder",
      detail: cwd,
      icon: menuIcon("Folder"),
      onPress: onChangeFolder,
    },
    {
      id: "restart",
      label: "Restart",
      ...(restartDetail ? { detail: restartDetail } : {}),
      icon: menuIcon("RotateCw"),
      onPress: onRestart,
    },
    { id: "upload", label: "Upload file", icon: menuIcon("Upload"), onPress: onUpload },
    { id: "search", label: "Search terminal", icon: menuIcon("Search"), onPress: onSearch },
    { id: "font-size", label: "Font size", icon: menuIcon("Type"), onPress: onFontSize },
    { id: "copy-mode", label: "Copy mode", icon: menuIcon("Copy"), onPress: onCopyMode },
    { id: "diagnostics", label: "Diagnostics", icon: menuIcon("Wrench"), onPress: onDiagnostics },
    // The only rule this menu needs: set the one destructive action apart.
    { id: "kill-separator", type: "separator" },
    {
      id: "kill",
      label: "Kill session",
      icon: menuIcon("Trash2", true),
      destructive: true,
      onPress: onKill,
    },
  ];

  const actions: readonly AppHeaderAction[] = [
    {
      accessibilityLabel: "Terminal actions",
      icon: "Ellipsis",
      onPress: () => showMenu(true),
      testID: "terminal-header-menu-button",
    },
  ];

  return (
    <>
      <AppHeader
        actions={actions}
        onBack={onBack}
        subtitle={`${agent.label} · ${hostName}${path ? ` · ${path}` : ""}`}
        testID="terminal-header"
        title={title}
      />
      {/* The screen stands the keyboard down while this menu is up, so a menu
          that comes back after a drawer closed over it has to say so — or the
          keyboard rises underneath it. */}
      <Menu
        entries={entries}
        onDismiss={() => showMenu(false)}
        onReturn={() => showMenu(true)}
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
