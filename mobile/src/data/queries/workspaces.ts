import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listAgents } from "@/data/api/endpoints/agents";
import { listSessions } from "@/data/api/endpoints/sessions";
import { listWorkspaceTemplates } from "@/data/api/endpoints/templates";
import {
  archiveWorkspace,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  patchWorkspace,
  unarchiveWorkspace,
} from "@/data/api/endpoints/workspaces";
import type {
  WorkspaceCreate,
  WorkspaceIconSource,
  WorkspaceOut,
} from "@/data/api/schemas/workspaces";
import { qk } from "@/data/queryKeys";
import { haptics } from "@/lib/haptics";

const WORKSPACE_STALE_MS = 30_000;
const SESSION_POLL_MS = 5_000;

export interface RenameWorkspaceInput {
  id: string;
  name: string;
}

export interface ChangeWorkspaceIconInput {
  id: string;
  icon: string | null;
  icon_source: WorkspaceIconSource;
}

function upsert(
  rows: readonly WorkspaceOut[] | undefined,
  workspace: WorkspaceOut,
): WorkspaceOut[] {
  const withoutWorkspace = (rows ?? []).filter((row) => row.id !== workspace.id);
  return [...withoutWorkspace, workspace];
}

function dateValue(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortWorkspaceCache(rows: readonly WorkspaceOut[], archived: boolean): WorkspaceOut[] {
  return [...rows].sort((left, right) => {
    if (archived) {
      return (
        dateValue(right.archived_at) - dateValue(left.archived_at) ||
        dateValue(right.created_at) - dateValue(left.created_at) ||
        left.id.localeCompare(right.id)
      );
    }
    return (
      left.position - right.position ||
      dateValue(left.created_at) - dateValue(right.created_at) ||
      left.id.localeCompare(right.id)
    );
  });
}

/** Writes every cache location whose truth is represented by a Workspace response. */
export function writeWorkspaceCaches(queryClient: QueryClient, workspace: WorkspaceOut): void {
  queryClient.setQueryData(qk.workspace(workspace.id), workspace);
  queryClient.setQueryData<WorkspaceOut[]>(qk.workspaces(), (rows) =>
    workspace.archived_at === null
      ? sortWorkspaceCache(upsert(rows, workspace), false)
      : (rows ?? []).filter((row) => row.id !== workspace.id),
  );
  queryClient.setQueryData<WorkspaceOut[]>(qk.archivedWorkspaces(), (rows) =>
    workspace.archived_at !== null
      ? sortWorkspaceCache(upsert(rows, workspace), true)
      : (rows ?? []).filter((row) => row.id !== workspace.id),
  );
}

export function removeWorkspaceCaches(queryClient: QueryClient, workspaceId: string): void {
  queryClient.setQueryData<WorkspaceOut[]>(qk.workspaces(), (rows) =>
    (rows ?? []).filter((row) => row.id !== workspaceId),
  );
  queryClient.setQueryData<WorkspaceOut[]>(qk.archivedWorkspaces(), (rows) =>
    (rows ?? []).filter((row) => row.id !== workspaceId),
  );
  queryClient.removeQueries({ queryKey: qk.workspace(workspaceId), exact: true });
}

async function invalidateWorkspaceFamily(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: qk.workspaces() });
}

function mutationError(): void {
  haptics.error();
}

function mutationSuccess(): void {
  haptics.success();
}

export function useWorkspacesQuery(archived = false) {
  return useQuery({
    queryKey: archived ? qk.archivedWorkspaces() : qk.workspaces(),
    queryFn: () => listWorkspaces(archived),
    staleTime: WORKSPACE_STALE_MS,
  });
}

export function useWorkspaceSessionsQuery() {
  return useQuery({
    queryKey: qk.sessions(),
    queryFn: () => listSessions(),
    refetchInterval: SESSION_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

export function useWorkspaceTemplatesQuery() {
  return useQuery({
    queryKey: qk.workspaceTemplates(),
    queryFn: listWorkspaceTemplates,
    staleTime: WORKSPACE_STALE_MS,
  });
}

export function useWorkspaceAgentsQuery() {
  return useQuery({
    queryKey: qk.agents(),
    queryFn: listAgents,
    staleTime: WORKSPACE_STALE_MS,
  });
}

export function useCreateWorkspaceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkspaceCreate) => createWorkspace(input),
    onSuccess: async ({ workspace }) => {
      writeWorkspaceCaches(queryClient, workspace);
      await invalidateWorkspaceFamily(queryClient);
      mutationSuccess();
    },
    onError: mutationError,
  });
}

export function useRenameWorkspaceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: RenameWorkspaceInput) => patchWorkspace(id, { name: name.trim() }),
    onSuccess: async (workspace) => {
      writeWorkspaceCaches(queryClient, workspace);
      await invalidateWorkspaceFamily(queryClient);
      mutationSuccess();
    },
    onError: mutationError,
  });
}

export function useChangeWorkspaceIconMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, icon, icon_source }: ChangeWorkspaceIconInput) =>
      patchWorkspace(id, { icon, icon_source }),
    onSuccess: async (workspace) => {
      writeWorkspaceCaches(queryClient, workspace);
      await invalidateWorkspaceFamily(queryClient);
      mutationSuccess();
    },
    onError: mutationError,
  });
}

export function useArchiveWorkspaceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => archiveWorkspace(workspaceId),
    onSuccess: async (workspace) => {
      writeWorkspaceCaches(queryClient, workspace);
      await Promise.all([
        invalidateWorkspaceFamily(queryClient),
        queryClient.invalidateQueries({ queryKey: qk.sessions() }),
      ]);
      mutationSuccess();
    },
    onError: mutationError,
  });
}

export function useUnarchiveWorkspaceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => unarchiveWorkspace(workspaceId),
    onSuccess: async (workspace) => {
      writeWorkspaceCaches(queryClient, workspace);
      await Promise.all([
        invalidateWorkspaceFamily(queryClient),
        queryClient.invalidateQueries({ queryKey: qk.sessions() }),
      ]);
      mutationSuccess();
    },
    onError: mutationError,
  });
}

export function useDeleteWorkspaceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => deleteWorkspace(workspaceId),
    onSuccess: async (_result, workspaceId) => {
      removeWorkspaceCaches(queryClient, workspaceId);
      await Promise.all([
        invalidateWorkspaceFamily(queryClient),
        queryClient.invalidateQueries({ queryKey: qk.sessions() }),
      ]);
      mutationSuccess();
    },
    onError: mutationError,
  });
}
