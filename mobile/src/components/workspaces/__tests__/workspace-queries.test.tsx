import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { listAgents } from "@/data/api/endpoints/agents";
import { listHosts } from "@/data/api/endpoints/hosts";
import { listSessions } from "@/data/api/endpoints/sessions";
import {
  archiveWorkspace,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  patchWorkspace,
} from "@/data/api/endpoints/workspaces";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { useWorkspaceDetail } from "@/data/queries/workspace-detail";
import {
  useArchiveWorkspaceMutation,
  useCreateWorkspaceMutation,
  useRenameWorkspaceMutation,
  useWorkspacesQuery,
} from "@/data/queries/workspaces";
import { qk } from "@/data/queryKeys";

jest.mock("@/data/api/endpoints/agents", () => ({ listAgents: jest.fn() }));
jest.mock("@/data/api/endpoints/hosts", () => ({ listHosts: jest.fn() }));
jest.mock("@/data/api/endpoints/sessions", () => ({ listSessions: jest.fn() }));
jest.mock("@/data/api/endpoints/templates", () => ({ listWorkspaceTemplates: jest.fn() }));
jest.mock("@/data/api/endpoints/workspaces", () => ({
  archiveWorkspace: jest.fn(),
  createWorkspace: jest.fn(),
  deleteWorkspace: jest.fn(),
  getWorkspace: jest.fn(),
  listWorkspaces: jest.fn(),
  patchWorkspace: jest.fn(),
  unarchiveWorkspace: jest.fn(),
}));

function workspace(overrides: Partial<WorkspaceOut> = {}): WorkspaceOut {
  return {
    id: "workspace-1",
    name: "Mobile",
    host_id: null,
    cwd: null,
    layout: {
      version: 3,
      active_tab: "tab-1",
      tabs: [
        {
          id: "tab-1",
          name: "Tab 1",
          host_id: null,
          cwd: null,
          layout: { version: 3, tiles: [] },
        },
      ],
    },
    position: 0,
    icon: null,
    icon_source: null,
    archived_at: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-22T00:00:00Z",
    ...overrides,
  };
}

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe("workspace query hooks", () => {
  beforeEach(() => jest.clearAllMocks());

  test("loads the active and archived endpoints with distinct keys", async () => {
    jest.mocked(listWorkspaces).mockResolvedValue([]);
    const { queryClient, wrapper } = harness();
    const active = await renderHook(() => useWorkspacesQuery(), { wrapper });
    await waitFor(() => expect(active.result.current.isSuccess).toBe(true));
    const archived = await renderHook(() => useWorkspacesQuery(true), { wrapper });
    await waitFor(() => expect(archived.result.current.isSuccess).toBe(true));
    expect(listWorkspaces).toHaveBeenCalledWith(false);
    expect(listWorkspaces).toHaveBeenCalledWith(true);
    await active.unmount();
    await archived.unmount();
    queryClient.clear();
  });

  test("create writes detail and list caches, then invalidates the workspace family", async () => {
    const created = workspace();
    jest.mocked(createWorkspace).mockResolvedValue({ workspace: created, session: null });
    const { queryClient, wrapper } = harness();
    const invalidate = jest.spyOn(queryClient, "invalidateQueries");
    const mutation = await renderHook(() => useCreateWorkspaceMutation(), { wrapper });
    await act(async () => {
      await mutation.result.current.mutateAsync({ name: "Mobile" });
    });
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true));
    expect(createWorkspace).toHaveBeenCalledWith({ name: "Mobile" });
    expect(queryClient.getQueryData(qk.workspace(created.id))).toEqual(created);
    expect(queryClient.getQueryData(qk.workspaces())).toEqual([created]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.workspaces() });
    await mutation.unmount();
    queryClient.clear();
  });

  test("rename uses PATCH and replaces both detail and active-list copies", async () => {
    const before = workspace();
    const renamed = workspace({ name: "Native" });
    jest.mocked(patchWorkspace).mockResolvedValue(renamed);
    const { queryClient, wrapper } = harness();
    queryClient.setQueryData(qk.workspace(before.id), before);
    queryClient.setQueryData(qk.workspaces(), [before]);
    const mutation = await renderHook(() => useRenameWorkspaceMutation(), { wrapper });
    await act(async () => {
      await mutation.result.current.mutateAsync({ id: before.id, name: "  Native  " });
    });
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true));
    expect(patchWorkspace).toHaveBeenCalledWith(before.id, { name: "Native" });
    expect(queryClient.getQueryData(qk.workspace(before.id))).toEqual(renamed);
    expect(queryClient.getQueryData(qk.workspaces())).toEqual([renamed]);
    await mutation.unmount();
    queryClient.clear();
  });

  test("archive moves the returned object between lists and invalidates session status", async () => {
    const before = workspace();
    const archived = workspace({ archived_at: "2026-08-22T01:00:00Z" });
    jest.mocked(archiveWorkspace).mockResolvedValue(archived);
    const { queryClient, wrapper } = harness();
    queryClient.setQueryData(qk.workspaces(), [before]);
    const invalidate = jest.spyOn(queryClient, "invalidateQueries");
    const mutation = await renderHook(() => useArchiveWorkspaceMutation(), { wrapper });
    await act(async () => {
      await mutation.result.current.mutateAsync(before.id);
    });
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true));
    expect(archiveWorkspace).toHaveBeenCalledWith(before.id);
    expect(queryClient.getQueryData(qk.workspace(before.id))).toEqual(archived);
    expect(queryClient.getQueryData(qk.workspaces())).toEqual([]);
    expect(queryClient.getQueryData(qk.archivedWorkspaces())).toEqual([archived]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.sessions() });
    await mutation.unmount();
    queryClient.clear();
  });

  test("a pull refetches every workspace resource and spins only while it runs", async () => {
    const detailWorkspace = workspace();
    jest.mocked(getWorkspace).mockResolvedValue(detailWorkspace);
    jest.mocked(listSessions).mockResolvedValue([]);
    jest.mocked(listHosts).mockResolvedValue([]);
    jest.mocked(listAgents).mockResolvedValue([]);
    const { queryClient, wrapper } = harness();
    const detail = await renderHook(() => useWorkspaceDetail(detailWorkspace.id), { wrapper });
    await waitFor(() => expect(detail.result.current.loading).toBe(false));

    // The session poll runs every five seconds. Only the pull may spin the
    // control, or the list twitches downwards on its own.
    expect(detail.result.current.refreshing).toBe(false);
    let finishWorkspace: (() => void) | undefined;
    jest.mocked(getWorkspace).mockReturnValueOnce(
      new Promise((resolve) => {
        finishWorkspace = () => resolve(detailWorkspace);
      }),
    );

    let pull: Promise<void> | undefined;
    await act(() => {
      pull = detail.result.current.refresh();
    });
    expect(detail.result.current.refreshing).toBe(true);

    await act(async () => {
      finishWorkspace?.();
      await pull;
    });
    expect(detail.result.current.refreshing).toBe(false);
    expect(getWorkspace).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listHosts).toHaveBeenCalledTimes(2);
    expect(listAgents).toHaveBeenCalledTimes(2);
    await detail.unmount();
    queryClient.clear();
  });
});
