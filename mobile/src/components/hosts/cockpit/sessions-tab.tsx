import { useMemo } from "react";
import { RefreshControl, SectionList, StyleSheet, View } from "react-native";
import {
  groupSessionsByWorkspace,
  type WorkspaceGroup,
} from "@/components/hosts/cockpit/cockpit-model";
import { HostSessionRow } from "@/components/hosts/host-session-row";
import { EmptyState } from "@/components/ui/empty-state";
import { ListGroupHeading } from "@/components/ui/list-group";
import { ListSeparator } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface SessionsTabProps {
  /** The host's name, for the empty state. */
  hostName: string;
  sessions: readonly SessionOut[];
  agents: readonly AgentOut[];
  /** Open workspaces first, then archived ones: each group names where its windows are. */
  workspaces: readonly WorkspaceOut[];
  refreshing: boolean;
  onRefresh(): void;
  onOpenSession(session: SessionOut): void;
}

/** A group's heading: the workspace, or the windows in none. */
export function workspaceGroupTitle(group: WorkspaceGroup): string {
  if (group.workspace === null) return "Not in a workspace";
  return group.workspace.archived_at === null
    ? group.workspace.name
    : `${group.workspace.name} · archived`;
}

/** Every window on this host, under the workspace that holds it. */
export function SessionsTab({
  hostName,
  sessions,
  agents,
  workspaces,
  refreshing,
  onRefresh,
  onOpenSession,
}: SessionsTabProps): React.JSX.Element {
  const theme = useTheme();
  const sections = useMemo(
    () =>
      groupSessionsByWorkspace(sessions, workspaces).map((group) => ({
        key: group.workspace?.id ?? "none",
        title: workspaceGroupTitle(group),
        data: group.sessions,
      })),
    [sessions, workspaces],
  );

  return (
    <SectionList
      contentContainerStyle={styles.list}
      ItemSeparatorComponent={ListSeparator}
      keyExtractor={(session) => session.id}
      ListEmptyComponent={
        <EmptyState
          description="Windows opened on this host are listed here, under the workspace they are in."
          icon="Terminal"
          style={styles.empty}
          title={`Nothing runs on ${hostName}.`}
        />
      }
      refreshControl={
        <RefreshControl
          onRefresh={onRefresh}
          refreshing={refreshing}
          tintColor={theme.colors.mutedForeground}
        />
      }
      renderItem={({ item }) => (
        <HostSessionRow agents={agents} onOpen={onOpenSession} session={item} />
      )}
      renderSectionHeader={({ section }) => (
        <View
          style={[styles.sectionHeader, { backgroundColor: theme.colors.background }]}
          testID={`host-sessions-group-${section.key}`}
        >
          <ListGroupHeading
            title={section.title}
            trailing={
              <Text color="mutedForeground" variant="caption">
                {section.data.length}
              </Text>
            }
          />
        </View>
      )}
      sections={sections}
      stickySectionHeadersEnabled={false}
      testID="host-sessions-tab"
    />
  );
}

const styles = StyleSheet.create({
  empty: {
    marginHorizontal: spacing[4],
    marginTop: spacing[6],
  },
  list: {
    flexGrow: 1,
    paddingBottom: spacing[8],
  },
  sectionHeader: {
    paddingHorizontal: sizing.screen.gutter,
    paddingTop: spacing[6],
  },
});
