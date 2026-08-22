import { memo, useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { type SwipeAction, SwipeableRow } from "@/components/gestures/swipeable-row";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import { identifyAgent } from "@/data/selectors/agent";
import { attentionRank, displayStatus, sessionTitle } from "@/data/selectors/session";
import type { AgentDef, Host, Session, TransportState } from "@/data/types/domain";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

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
      contentStyle={{ backgroundColor: theme.colors.background }}
      leadingActions={leadingActions}
      style={{ borderRadius: theme.radii.lg }}
      testID={`terminal-swipe-${session.id}`}
      trailingActions={trailingActions}
    >
      <View style={styles.frame} testID={`terminal-row-${session.id}`}>
        <ListRow
          height="tall"
          leading={
            <View style={styles.iconFrame}>
              <AgentIcon identity={identity} size={sizing.listRow.leading.pane} />
              <StatusDot
                bordered
                pulse={status.pulse}
                style={styles.iconStatus}
                testID={`terminal-status-dot-${session.id}`}
                tone={status.tone}
              />
            </View>
          }
          onLongPress={() => {
            haptics.impact("medium");
            onActions();
          }}
          onPress={() => {
            haptics.selection();
            onOpen();
          }}
          subtitle={detail}
          title={title}
          trailing={
            <View style={styles.status}>
              <StatusDot pulse={status.pulse} tone={status.tone} />
              <Text color={statusColor} numberOfLines={1} variant="caption">
                {status.label}
              </Text>
            </View>
          }
        />
        <IconButton
          accessibilityLabel={`Actions for ${title}`}
          icon="Ellipsis"
          onPress={onActions}
          style={styles.action}
        />
      </View>
    </SwipeableRow>
  );
});

const styles = StyleSheet.create({
  action: {
    height: sizing.listRow.trailingTarget,
    position: "absolute",
    right: 0,
    top: (sizing.listRow.tall - sizing.listRow.trailingTarget) / 2,
    width: sizing.listRow.trailingTarget,
  },
  frame: {
    position: "relative",
  },
  iconFrame: {
    flexShrink: 0,
    position: "relative",
  },
  iconStatus: {
    bottom: 0,
    position: "absolute",
    right: 0,
  },
  status: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.space.peer,
    paddingRight: sizing.listRow.trailingTarget,
  },
});
