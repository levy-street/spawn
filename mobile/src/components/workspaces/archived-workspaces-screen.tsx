import { type Href, useRouter } from "expo-router";
import { useMemo } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";

import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import { ArchivedWorkspaceRow } from "@/components/workspaces/archived-workspace-row";
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
import { borderWidth, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

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
    <Screen
      header={
        <AppHeader
          onBack={onBack}
          testID="archived-workspaces-header"
          title="Archived workspaces"
        />
      }
      padded={false}
    >
      <View
        style={[styles.screen, { backgroundColor: theme.colors.background }]}
        testID="archived-workspaces-screen"
      >
        <View style={[styles.truthfulCopy, { borderColor: theme.colors.border }]}>
          <Text color="mutedForeground" variant="caption">
            Archive suspends a workspace; it does not delete it. Its sessions and layout are
            retained, and Restore restarts those same sessions where hosts are online.
          </Text>
        </View>
        {loading ? (
          <View style={styles.center}>
            <Spinner label="Loading archived workspaces" size={sizing.listRow.leading.glyph} />
          </View>
        ) : error ? (
          <View style={styles.state}>
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
          </View>
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
      </View>
    </Screen>
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
  center: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  list: {
    flexGrow: 1,
    gap: sizing.space.cluster,
    padding: sizing.space.block,
  },
  screen: {
    flex: 1,
  },
  state: {
    flex: 1,
    padding: sizing.space.block,
  },
  truthfulCopy: {
    borderBottomWidth: borderWidth.hairline,
    paddingHorizontal: sizing.screen.gutter,
    paddingVertical: sizing.space.cluster,
  },
});
