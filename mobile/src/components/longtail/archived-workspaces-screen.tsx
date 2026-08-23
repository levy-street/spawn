import { type Href, useRouter } from "expo-router";
import { useMemo } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { formatLongtailDate } from "@/components/longtail/longtail-format";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import { WorkspaceIcon } from "@/components/workspaces/workspace-icon";
import {
  workspaceErrorMessage,
  workspaceForSelectors,
} from "@/components/workspaces/workspace-list-model";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import {
  useDeleteWorkspaceMutation,
  useUnarchiveWorkspaceMutation,
  useWorkspacesQuery,
} from "@/data/queries/workspaces";
import { sortWorkspaces } from "@/data/selectors/workspace";
import { haptics } from "@/lib/haptics";
import { borderWidth, fontSize, lineHeight, opacity, spacing, useTheme } from "@/theme";

interface ArchivedWorkspaceRowProps {
  busy: boolean;
  workspace: WorkspaceOut;
  onDelete: () => void;
  onOpen: () => void;
  onRestore: () => void;
}

function ArchivedWorkspaceRow({
  busy,
  workspace,
  onDelete,
  onOpen,
  onRestore,
}: ArchivedWorkspaceRowProps): React.JSX.Element {
  const theme = useTheme();
  const tabCount = workspace.layout.tabs.length;
  const archivedWhen = formatLongtailDate(workspace.archived_at);

  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          opacity: busy ? opacity.disabled : opacity.opaque,
        },
      ]}
      testID={`archived-workspace-${workspace.id}`}
    >
      <Pressable
        accessibilityHint="Opens the retained workspace layout"
        accessibilityLabel={`Open archived workspace ${workspace.name}`}
        accessibilityRole="button"
        disabled={busy}
        onPress={onOpen}
        style={({ pressed }) => [
          styles.summary,
          { backgroundColor: pressed ? theme.colors.accent : "transparent" },
        ]}
      >
        <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={spacing[11]} />
        <View style={styles.copy}>
          <Text numberOfLines={1} variant="label">
            {workspace.name}
          </Text>
          <Text color="mutedForeground" numberOfLines={1} variant="caption">
            {tabCount} {tabCount === 1 ? "tab" : "tabs"} · archived {archivedWhen}
          </Text>
        </View>
        <Icon color="mutedForeground" name="ChevronRight" size={spacing[4]} />
      </Pressable>
      <View style={[styles.actions, { borderTopColor: theme.colors.border }]}>
        <Button disabled={busy} onPress={onRestore} size="sm" variant="outline">
          <Icon color="foreground" name="RotateCcw" size={spacing[4]} />
          Restore
        </Button>
        <IconButton
          accessibilityLabel={`Delete ${workspace.name} forever`}
          disabled={busy}
          icon="Trash2"
          onPress={onDelete}
          size="sm"
          variant="ghost"
        />
      </View>
    </View>
  );
}

export interface ArchivedWorkspacesViewProps {
  busyId?: string | undefined;
  error?: string | undefined;
  loading: boolean;
  onBack: () => void;
  onDelete: (workspace: WorkspaceOut) => void;
  onOpen: (workspace: WorkspaceOut) => void;
  onRefresh: () => void;
  onRestore: (workspace: WorkspaceOut) => void;
  refreshing: boolean;
  workspaces: readonly WorkspaceOut[];
}

export function ArchivedWorkspacesView({
  busyId,
  error,
  loading,
  onBack,
  onDelete,
  onOpen,
  onRefresh,
  onRestore,
  refreshing,
  workspaces,
}: ArchivedWorkspacesViewProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <IconButton accessibilityLabel="Back to workspaces" icon="ChevronLeft" onPress={onBack} />
        <Text accessibilityRole="header" style={styles.heading} weight="semibold">
          Archived
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={[styles.truthfulCopy, { borderColor: theme.colors.border }]}>
        <Text color="mutedForeground" variant="caption">
          Archive suspends a workspace; it does not delete it. Its sessions and layout are retained,
          and Restore restarts those same sessions where hosts are online.
        </Text>
      </View>
      {loading ? (
        <View style={styles.center}>
          <Spinner label="Loading archived workspaces" size={spacing[6]} />
        </View>
      ) : error ? (
        <EmptyState
          action={
            <Button onPress={onRefresh} variant="outline">
              Try again
            </Button>
          }
          description={error}
          icon="Archive"
          title="Archived workspaces unavailable"
        />
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={workspaces}
          keyExtractor={(workspace) => workspace.id}
          ListEmptyComponent={
            <EmptyState
              description="Workspaces you archive will stay here until you restore or permanently delete them."
              icon="Archive"
              title="No archived workspaces"
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
            <ArchivedWorkspaceRow
              busy={busyId === item.id}
              onDelete={() => onDelete(item)}
              onOpen={() => onOpen(item)}
              onRestore={() => onRestore(item)}
              workspace={item}
            />
          )}
          testID="archived-workspaces-list"
        />
      )}
    </SafeAreaView>
  );
}

export function ArchivedWorkspacesScreen(): React.JSX.Element {
  const router = useRouter();
  const toast = useToast();
  const query = useWorkspacesQuery(true);
  const restoreMutation = useUnarchiveWorkspaceMutation();
  const deleteMutation = useDeleteWorkspaceMutation();
  const workspaces = useMemo(
    () => sortWorkspaces((query.data ?? []).map(workspaceForSelectors), true),
    [query.data],
  );
  const originalById = useMemo(
    () => new Map((query.data ?? []).map((workspace) => [workspace.id, workspace])),
    [query.data],
  );
  const ordered = workspaces.flatMap((workspace) => {
    const original = originalById.get(workspace.id);
    return original ? [original] : [];
  });
  const busyId = restoreMutation.isPending
    ? restoreMutation.variables
    : deleteMutation.isPending
      ? deleteMutation.variables
      : undefined;

  const restore = (workspace: WorkspaceOut) => {
    restoreMutation.mutate(workspace.id, {
      onSuccess: () => {
        toast.success(`Restored ${workspace.name}`, {
          detail: "Its retained sessions are restarting where hosts are online.",
        });
      },
      onError: (error) => {
        toast.error("Workspace could not be restored", {
          detail: workspaceErrorMessage(error),
        });
      },
    });
  };

  const remove = async (workspace: WorkspaceOut) => {
    const accepted = await confirm({
      title: `Delete ${workspace.name} forever?`,
      description:
        "Its retained layout and session records will be permanently removed. This cannot be undone.",
      confirmLabel: "Delete forever",
      destructive: true,
    });
    if (!accepted) return;
    deleteMutation.mutate(workspace.id, {
      onSuccess: () => toast.success(`Deleted ${workspace.name}`),
      onError: (error) =>
        toast.error("Workspace could not be deleted", { detail: workspaceErrorMessage(error) }),
    });
  };

  return (
    <ArchivedWorkspacesView
      busyId={busyId}
      error={query.error ? workspaceErrorMessage(query.error) : undefined}
      loading={query.isLoading}
      onBack={() => router.back()}
      onDelete={(workspace) => void remove(workspace)}
      onOpen={(workspace) => {
        haptics.selection();
        router.push({ pathname: "/workspace/[id]", params: { id: workspace.id } } as Href);
      }}
      onRefresh={() => void query.refetch()}
      onRestore={restore}
      refreshing={query.isRefetching}
      workspaces={ordered}
    />
  );
}

const styles = StyleSheet.create({
  actions: {
    alignItems: "center",
    borderTopWidth: borderWidth.hairline,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  copy: {
    flex: 1,
    gap: spacing[1],
    minWidth: spacing[0],
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[2],
  },
  headerSpacer: {
    width: spacing[10],
  },
  heading: {
    flex: 1,
    fontSize: fontSize.displaySm,
    lineHeight: lineHeight.xl,
    textAlign: "center",
  },
  list: {
    flexGrow: 1,
    gap: spacing[3],
    padding: spacing[4],
    paddingBottom: spacing[20],
  },
  row: {
    borderWidth: borderWidth.hairline,
    overflow: "hidden",
  },
  screen: {
    flex: 1,
  },
  summary: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    minHeight: spacing[16],
    padding: spacing[3],
  },
  truthfulCopy: {
    borderBottomWidth: borderWidth.hairline,
    borderTopWidth: borderWidth.hairline,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
});
