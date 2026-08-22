import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { launcherOrchestrator, useLaunchSession } from "@/data/queries/launcher";
import { qk } from "@/data/queryKeys";

import { makeHost, makeSession, makeWorkspace } from "./fixtures";

describe("launcher query integration", () => {
  it("publishes a launched session immediately and refreshes the active workspace", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { gcTime: Number.POSITIVE_INFINITY, retry: false },
        queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
      },
    });
    const existing = makeSession({ id: "existing-session" });
    const launched = makeSession({ id: "launched-session" });
    const workspace = makeWorkspace();
    queryClient.setQueryData(qk.sessions(), [existing]);
    const invalidate = jest.spyOn(queryClient, "invalidateQueries");
    const launch = jest.spyOn(launcherOrchestrator, "launch").mockResolvedValue({
      status: "launched",
      session: launched,
      pendingCommand: false,
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = await renderHook(() => useLaunchSession(), { wrapper });

    await act(async () => {
      await hook.result.current.mutateAsync({
        workspaceId: workspace.id,
        tabId: "tab-1",
        hostId: makeHost().id,
        cwd: "/Users/ada/spawn",
      });
    });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: workspace.id, tabId: "tab-1" }),
    );
    expect(queryClient.getQueryData(qk.session(launched.id))).toEqual(launched);
    expect(queryClient.getQueryData(qk.sessions())).toEqual([existing, launched]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.workspace(workspace.id) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.workspaces() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.sessions() });

    launch.mockRestore();
    await hook.unmount();
    queryClient.clear();
  });
});
