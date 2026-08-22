import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type Href, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { SearchField } from "@/components/ui/search-field";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import { ArchivedWorkspacesLink } from "@/components/workspaces/archived-workspaces-link";
import { ChangeWorkspaceIconDialog } from "@/components/workspaces/change-workspace-icon-dialog";
import { CreateWorkspaceDialog } from "@/components/workspaces/create-workspace-dialog";
import { RenameWorkspaceDialog } from "@/components/workspaces/rename-workspace-dialog";
import { WorkspaceListEmpty } from "@/components/workspaces/workspace-list-empty";
import { WorkspaceListError } from "@/components/workspaces/workspace-list-error";
import { WorkspaceListHeader } from "@/components/workspaces/workspace-list-header";
import {
  type WorkspaceOperationInput,
  type WorkspaceRowModel,
  workspaceErrorMessage,
  workspaceForSelectors,
} from "@/components/workspaces/workspace-list-model";
import { WorkspaceListSkeletons } from "@/components/workspaces/workspace-list-skeletons";
import { workspaceListStyles as styles } from "@/components/workspaces/workspace-list-styles";
import {
  duplicateWorkspaceDeep,
  instantiateWorkspaceTemplate,
  type WorkspaceOperationResult,
} from "@/components/workspaces/workspace-operations";
import { WorkspaceRow } from "@/components/workspaces/workspace-row";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import {
  useArchiveWorkspaceMutation,
  useChangeWorkspaceIconMutation,
  useCreateWorkspaceMutation,
  useDeleteWorkspaceMutation,
  useRenameWorkspaceMutation,
  useUnarchiveWorkspaceMutation,
  useWorkspaceAgentsQuery,
  useWorkspaceSessionsQuery,
  useWorkspacesQuery,
  useWorkspaceTemplatesQuery,
  writeWorkspaceCaches,
} from "@/data/queries/workspaces";
import { qk } from "@/data/queryKeys";
import {
  filterWorkspaces,
  selectOrderedWorkspaces,
  selectWorkspaceStats,
} from "@/data/selectors/workspace";
import type { DomainSnapshot, Workspace } from "@/data/types/domain";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/theme";

export function WorkspaceListScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const workspacesQuery = useWorkspacesQuery();
  const archivedQuery = useWorkspacesQuery(true);
  const sessionsQuery = useWorkspaceSessionsQuery();
  const templatesQuery = useWorkspaceTemplatesQuery();
  const agentsQuery = useWorkspaceAgentsQuery();
  const createMutation = useCreateWorkspaceMutation();
  const renameMutation = useRenameWorkspaceMutation();
  const iconMutation = useChangeWorkspaceIconMutation();
  const archiveMutation = useArchiveWorkspaceMutation();
  const unarchiveMutation = useUnarchiveWorkspaceMutation();
  const deleteMutation = useDeleteWorkspaceMutation();
  const [query, setQuery] = useState("");
  const [createVisible, setCreateVisible] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkspaceOut | null>(null);
  const [iconTarget, setIconTarget] = useState<WorkspaceOut | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const openCreate = useCallback(() => setCreateVisible(true), []);

  const operationMutation = useMutation({
    mutationFn: async (input: WorkspaceOperationInput): Promise<WorkspaceOperationResult> => {
      if (input.kind === "duplicate") return duplicateWorkspaceDeep(input);
      const template = templatesQuery.data?.find((item) => item.id === input.templateId);
      if (!template) throw new Error("The selected template is no longer available.");
      return instantiateWorkspaceTemplate({
        template,
        agents: input.agents,
        name: input.draft.name,
        ...(input.draft.iconChoice
          ? {
              icon: input.draft.iconChoice.icon,
              iconSource: input.draft.iconChoice.iconSource,
            }
          : {}),
      });
    },
    onSuccess: async (result, variables) => {
      writeWorkspaceCaches(queryClient, result.workspace);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.workspaces() }),
        queryClient.invalidateQueries({ queryKey: qk.sessions() }),
      ]);
      const detail =
        result.agentLaunchesSkipped > 0
          ? `${result.agentLaunchesSkipped} agent ${result.agentLaunchesSkipped === 1 ? "command could" : "commands could"} not be queued; ${result.agentLaunchesSkipped === 1 ? "the shell was" : "the shells were"} kept.`
          : undefined;
      if (variables.kind === "template") {
        setCreateVisible(false);
        toast.success("Workspace created", detail ? { detail } : undefined);
        router.push({
          pathname: "/workspace/[id]",
          params: { id: result.workspace.id },
        } as Href);
      } else {
        toast.success("Workspace duplicated", detail ? { detail } : undefined);
      }
    },
    onError: (error) => {
      toast.error("Workspace action failed", { detail: workspaceErrorMessage(error) });
    },
  });

  const workspaces = workspacesQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const snapshot = useMemo<DomainSnapshot>(() => {
    const workspacesById = new Map<string, Workspace>(
      workspaces.map((workspace) => [workspace.id, workspaceForSelectors(workspace)]),
    );
    return {
      workspacesById,
      sessionsById: new Map(sessions.map((session) => [session.id, session])),
      hostsById: new Map(),
      agents,
    };
  }, [agents, sessions, workspaces]);

  const rows = useMemo<WorkspaceRowModel[]>(() => {
    const originalById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    return filterWorkspaces(selectOrderedWorkspaces(snapshot, false), query).flatMap(
      (workspace): WorkspaceRowModel[] => {
        const original = originalById.get(workspace.id);
        const stats = selectWorkspaceStats(snapshot, workspace.id);
        return original && stats ? [{ workspace: original, stats }] : [];
      },
    );
  }, [query, snapshot, workspaces]);

  const busy =
    createMutation.isPending ||
    renameMutation.isPending ||
    iconMutation.isPending ||
    archiveMutation.isPending ||
    unarchiveMutation.isPending ||
    deleteMutation.isPending ||
    operationMutation.isPending;

  const openWorkspace = (workspace: WorkspaceOut) => {
    haptics.selection();
    router.push({ pathname: "/workspace/[id]", params: { id: workspace.id } } as Href);
  };

  const requestArchive = async (row: WorkspaceRowModel) => {
    if (row.stats.running > 0) {
      const accepted = await confirm({
        title: `Archive ${row.workspace.name}?`,
        description: `${row.stats.running} running ${row.stats.running === 1 ? "session" : "sessions"} will be stopped. The layout is kept — restore it any time from Archived and every window starts again where it is.`,
        confirmLabel: "Archive workspace",
      });
      if (!accepted) return;
    }
    if (row.stats.running === 0) haptics.warning();
    archiveMutation.mutate(row.workspace.id, {
      onSuccess: () => toast.success(`Archived ${row.workspace.name}`),
      onError: (error) =>
        toast.error("Workspace could not be archived", { detail: workspaceErrorMessage(error) }),
    });
  };

  const requestDelete = async (workspace: WorkspaceOut) => {
    const archived = workspace.archived_at !== null;
    const accepted = await confirm({
      title: archived ? `Delete ${workspace.name} forever?` : `Delete ${workspace.name}?`,
      description: archived
        ? "Its layout is discarded. This cannot be undone."
        : "Every session in this workspace will be closed and its process will be killed.",
      confirmLabel: archived ? "Delete forever" : "Delete workspace",
      destructive: true,
    });
    if (!accepted) return;
    deleteMutation.mutate(workspace.id, {
      onSuccess: () => toast.success(`Deleted ${workspace.name}`),
      onError: (error) =>
        toast.error("Workspace could not be deleted", { detail: workspaceErrorMessage(error) }),
    });
  };

  const renderItem: ListRenderItem<WorkspaceRowModel> = ({ item }) => (
    <WorkspaceRow
      busy={busy}
      onArchive={() => void requestArchive(item)}
      onChangeIcon={() => setIconTarget(item.workspace)}
      onDelete={() => void requestDelete(item.workspace)}
      onDuplicate={() =>
        operationMutation.mutate({
          kind: "duplicate",
          workspace: item.workspace,
          sessions,
          agents,
          existingNames: workspaces.map((workspace) => workspace.name),
        })
      }
      onOpen={() => openWorkspace(item.workspace)}
      onRename={() => setRenameTarget(item.workspace)}
      onUnarchive={() =>
        unarchiveMutation.mutate(item.workspace.id, {
          onSuccess: () => toast.success(`Restored ${item.workspace.name}`),
          onError: (error) =>
            toast.error("Workspace could not be restored", {
              detail: workspaceErrorMessage(error),
            }),
        })
      }
      stats={item.stats}
      workspace={item.workspace}
    />
  );

  const refreshWorkspaces = workspacesQuery.refetch;
  const refreshArchived = archivedQuery.refetch;
  const refreshSessions = sessionsQuery.refetch;
  const refreshTemplates = templatesQuery.refetch;
  const refresh = useCallback(async () => {
    if (manualRefreshing) return;
    setManualRefreshing(true);
    try {
      await Promise.all([
        refreshWorkspaces(),
        refreshArchived(),
        refreshSessions(),
        refreshTemplates(),
      ]);
    } finally {
      setManualRefreshing(false);
    }
  }, [manualRefreshing, refreshArchived, refreshSessions, refreshTemplates, refreshWorkspaces]);

  if (workspacesQuery.isLoading) {
    return (
      <View
        style={[styles.screen, { backgroundColor: theme.colors.background }]}
        testID="workspace-list-screen"
      >
        <WorkspaceListHeader canCreate={false} onCreate={openCreate} />
        <WorkspaceListSkeletons />
      </View>
    );
  }

  if (workspacesQuery.error) {
    return (
      <View
        style={[styles.screen, { backgroundColor: theme.colors.background }]}
        testID="workspace-list-screen"
      >
        <WorkspaceListHeader canCreate={false} onCreate={openCreate} />
        <WorkspaceListError
          message={workspaceErrorMessage(workspacesQuery.error)}
          onRetry={() => void refresh()}
        />
      </View>
    );
  }

  return (
    <View
      style={[styles.screen, { backgroundColor: theme.colors.background }]}
      testID="workspace-list-screen"
    >
      <WorkspaceListHeader canCreate onCreate={openCreate} />
      <View style={styles.search}>
        <SearchField onChangeText={setQuery} placeholder="Search workspaces" value={query} />
      </View>
      {sessionsQuery.error ? (
        <View
          accessibilityRole="alert"
          style={[styles.statusError, { borderColor: theme.colors.border }]}
        >
          <Text color="mutedForeground" variant="caption">
            Session status is unavailable.
          </Text>
          <Button onPress={() => void sessionsQuery.refetch()} size="sm" variant="ghost">
            Retry
          </Button>
        </View>
      ) : null}
      <FlashList
        contentContainerStyle={styles.listContent}
        data={rows}
        ItemSeparatorComponent={WorkspaceRowSeparator}
        keyExtractor={(item) => item.workspace.id}
        ListEmptyComponent={<WorkspaceListEmpty onCreate={openCreate} query={query} />}
        ListFooterComponent={
          <ArchivedWorkspacesLink
            count={archivedQuery.data?.length ?? 0}
            onPress={() => router.push("/workspaces/archived" as Href)}
          />
        }
        onRefresh={() => void refresh()}
        refreshing={manualRefreshing}
        renderItem={renderItem}
        testID="workspace-list"
      />
      <CreateWorkspaceDialog
        busy={busy}
        onCreate={(draft) => {
          if (draft.templateId) {
            operationMutation.mutate({
              kind: "template",
              draft,
              templateId: draft.templateId,
              agents,
            });
            return;
          }
          createMutation.mutate(
            {
              name: draft.name,
              ...(draft.iconChoice
                ? {
                    icon: draft.iconChoice.icon,
                    icon_source: draft.iconChoice.iconSource,
                  }
                : {}),
            },
            {
              onSuccess: ({ workspace }) => {
                setCreateVisible(false);
                toast.success("Workspace created");
                router.push({
                  pathname: "/workspace/[id]",
                  params: { id: workspace.id },
                } as Href);
              },
              onError: (error) =>
                toast.error("Workspace could not be created", {
                  detail: workspaceErrorMessage(error),
                }),
            },
          );
        }}
        onDismiss={() => setCreateVisible(false)}
        templates={templatesQuery.data ?? []}
        visible={createVisible}
      />
      <RenameWorkspaceDialog
        busy={renameMutation.isPending}
        onDismiss={() => setRenameTarget(null)}
        onRename={(name) => {
          if (!renameTarget) return;
          renameMutation.mutate(
            { id: renameTarget.id, name },
            {
              onSuccess: () => {
                setRenameTarget(null);
                toast.success("Workspace renamed");
              },
              onError: (error) =>
                toast.error("Workspace could not be renamed", {
                  detail: workspaceErrorMessage(error),
                }),
            },
          );
        }}
        workspace={renameTarget}
      />
      <ChangeWorkspaceIconDialog
        busy={iconMutation.isPending}
        onDismiss={() => setIconTarget(null)}
        onSave={(choice) => {
          if (!iconTarget) return;
          iconMutation.mutate(
            { id: iconTarget.id, icon: choice.icon, icon_source: choice.iconSource },
            {
              onSuccess: () => {
                setIconTarget(null);
                toast.success("Workspace icon updated");
              },
              onError: (error) =>
                toast.error("Workspace icon could not be updated", {
                  detail: workspaceErrorMessage(error),
                }),
            },
          );
        }}
        workspace={iconTarget}
      />
    </View>
  );
}

function WorkspaceRowSeparator() {
  return <View style={styles.rowSeparator} />;
}
