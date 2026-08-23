import { memo } from "react";
import { StyleSheet, View } from "react-native";

import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import { paneRowStyles } from "@/components/workspace-detail/pane-row-styles";
import { identifyAgent } from "@/data/selectors/agent";
import { attentionRank, displayStatus, sessionTitle } from "@/data/selectors/session";
import type { AgentDef, Host, Session, TransportState } from "@/data/types/domain";
import { haptics } from "@/lib/haptics";
import { sizing } from "@/theme/sizing";

export interface TerminalRowProps {
  session: Session;
  host: Host | null;
  agents: readonly AgentDef[];
  transport: TransportState;
  onOpen: () => void;
  onActions: () => void;
}

export const TerminalRow = memo(function TerminalRow({
  session,
  host,
  agents,
  transport,
  onOpen,
  onActions,
}: TerminalRowProps) {
  const identity = identifyAgent(session.foreground_command, agents);
  const status = displayStatus(session, host, transport);
  const rank = attentionRank(session);
  const title = sessionTitle(session, agents);
  const hostName = host?.name ?? session.host_name;
  const detail = hostName ? `${identity.displayName} · ${hostName}` : identity.displayName;
  const statusColor = rank === 2 ? "destructive" : rank === 1 ? "warning" : "mutedForeground";

  // Rename, move and close all live in the row's ... menu; a swipe layer duplicating
  // them only added a hidden second path to the same three actions.
  return (
    <View style={paneRowStyles.frame} testID={`terminal-row-${session.id}`}>
      <ListRow
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
        shape="fullBleed"
        subtitle={detail}
        title={title}
        trailing={
          <View style={paneRowStyles.status}>
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
        size="lg"
        style={paneRowStyles.action}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  iconFrame: {
    flexShrink: 0,
    position: "relative",
  },
  iconStatus: {
    bottom: 0,
    position: "absolute",
    right: 0,
  },
});
