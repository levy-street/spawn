import { memo, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { type SwipeAction, SwipeableRow } from "@/components/gestures/swipeable-row";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import { identifyAgent } from "@/data/selectors/agent";
import { attentionRank, displayStatus, sessionTitle } from "@/data/selectors/session";
import type { AgentDef, Host, Session, TransportState } from "@/data/types/domain";
import { haptics } from "@/lib/haptics";
import { borderWidth, chrome, opacity, useTheme } from "@/theme";

export interface TerminalRowProps {
  session: Session;
  host: Host | null;
  agents: readonly AgentDef[];
  transport: TransportState;
  onOpen: () => void;
  onActions: () => void;
  onRename: () => void;
  onMove: () => void;
  onClose: () => void;
}

export const TerminalRow = memo(function TerminalRow({
  session,
  host,
  agents,
  transport,
  onOpen,
  onActions,
  onRename,
  onMove,
  onClose,
}: TerminalRowProps) {
  const theme = useTheme();
  const identity = identifyAgent(session.foreground_command, agents);
  const status = displayStatus(session, host, transport);
  const rank = attentionRank(session);
  const title = sessionTitle(session, agents);
  const hostName = host?.name ?? session.host_name;
  const detail = hostName
    ? `${identity.displayName} · ${hostName} · ${session.cwd}`
    : `${identity.displayName} · ${session.cwd}`;
  const statusColor = rank === 2 ? "destructive" : rank === 1 ? "warning" : "mutedForeground";

  const leadingActions = useMemo<SwipeAction[]>(
    () => [
      {
        key: "move",
        label: "Move",
        icon: <Icon name="ArrowRightLeft" />,
        onPress: onMove,
      },
    ],
    [onMove],
  );
  const trailingActions = useMemo<SwipeAction[]>(
    () => [
      {
        key: "rename",
        label: "Rename",
        icon: <Icon name="Pencil" />,
        onPress: onRename,
      },
      {
        key: "close",
        label: "Close",
        icon: <Icon color="destructiveForeground" name="Trash2" />,
        tone: "destructive",
        onPress: onClose,
      },
    ],
    [onClose, onRename],
  );

  return (
    <SwipeableRow
      contentStyle={{ backgroundColor: theme.colors.card }}
      leadingActions={leadingActions}
      style={{ borderRadius: theme.radii.lg }}
      testID={`terminal-swipe-${session.id}`}
      trailingActions={trailingActions}
    >
      <Pressable
        accessibilityActions={[{ name: "activate" }, { name: "longpress", label: "Show actions" }]}
        accessibilityLabel={`${title}, ${identity.displayName}, ${status.label}`}
        accessibilityRole="button"
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "longpress") onActions();
          else if (event.nativeEvent.actionName === "activate") onOpen();
        }}
        onLongPress={() => {
          haptics.impact("medium");
          onActions();
        }}
        onPress={onOpen}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: pressed ? theme.colors.accent : theme.colors.card,
            borderColor: theme.colors.border,
            borderRadius: theme.radii.lg,
            borderWidth: borderWidth.hairline,
            gap: theme.space(3),
            minHeight: theme.space(18),
            opacity: pressed ? opacity.hoverButton : opacity.opaque,
            paddingHorizontal: theme.space(3),
            paddingVertical: theme.space(2.5),
          },
        ]}
        testID={`terminal-row-${session.id}`}
      >
        <View style={styles.iconFrame}>
          <AgentIcon identity={identity} />
          <StatusDot
            bordered
            pulse={status.pulse}
            style={styles.iconStatus}
            testID={`terminal-status-dot-${session.id}`}
            tone={status.tone}
          />
        </View>
        <View style={styles.copy}>
          <Text numberOfLines={1} variant="label" weight="semibold">
            {title}
          </Text>
          <Text color="mutedForeground" numberOfLines={1} variant="caption">
            {detail}
          </Text>
        </View>
        <View style={styles.trailing}>
          <View style={[styles.status, { gap: theme.space(1.5) }]}>
            <StatusDot pulse={status.pulse} tone={status.tone} />
            <Text color={statusColor} numberOfLines={1} variant="caption">
              {status.label}
            </Text>
          </View>
          <Icon color="mutedForeground" name="Ellipsis" size={theme.space(4)} />
        </View>
      </Pressable>
    </SwipeableRow>
  );
});

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    minWidth: 0,
  },
  iconFrame: {
    flexShrink: 0,
    position: "relative",
  },
  iconStatus: {
    bottom: -borderWidth.emphasis,
    position: "absolute",
    right: -borderWidth.emphasis,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: chrome.touchTarget,
  },
  status: {
    alignItems: "center",
    flexDirection: "row",
  },
  trailing: {
    alignItems: "flex-end",
    alignSelf: "stretch",
    justifyContent: "space-between",
    maxWidth: "34%",
  },
});
