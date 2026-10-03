import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { pendingLaunches } from "@/components/launcher/pending-launch";
import { useWorkspaceActions } from "@/components/workspace-detail/use-workspace-actions";
import { ApiError } from "@/data/api/client";
import { createSession, deleteSession, moveSession } from "@/data/api/endpoints/sessions";
import { qk } from "@/data/queryKeys";
import type { Session } from "@/data/types/domain";

import { makeAgent, makeHost, makeSession } from "./fixtures";

jest.mock("@/data/api/endpoints/sessions", () => ({
  createSession: jest.fn(),
  deleteSession: jest.fn(async () => undefined),
  getSessionAccess: jest.fn(async () => ({ skills: [] })),
  moveSession: jest.fn(),
  patchSession: jest.fn(),
  restartSession: jest.fn(),
}));

jest.mock("@/data/api/endpoints/workspaces", () => ({ patchWorkspace: jest.fn() }));

const mockCommit = jest.fn();

jest.mock("@/data/queries/workspace-detail", () => ({
  normalizeWorkspace: (value: unknown) => value,
  useWorkspaceLayoutCommit: () => mockCommit,
  useWorkspaceReorder: () => ({ schedule: jest.fn(), flush: jest.fn() }),
}));

jest.mock("@/components/launcher/pending-launch", () => ({
  pendingLaunches: { persist: jest.fn(async () => undefined) },
}));

jest.mock("expo-crypto", () => ({ randomUUID: () => "0b0e7c1e-1111-4a2a-9c3c-5d6e7f809102" }));

const host = makeHost({ id: "host-2", name: "studio" });
const pane = makeSession({ id: "session-1", name: "builder", host_id: "host-1" });
const moved = makeSession({
  id: "session-1",
  name: "builder",
  host_id: host.id,
  host_name: host.name,
  cwd: "/srv/app",
  status: "starting",
});

async function actions(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  function Providers({ children }: PropsWithChildren): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const hook = await renderHook(() => useWorkspaceActions(jest.fn()), { wrapper: Providers });
  return hook.result.current;
}

describe("moving a window to another host", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (moveSession as jest.Mock).mockResolvedValue(moved);
  });

  test("moves the same window — no new session, no layout write, nothing deleted", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData<Session[]>(qk.sessions(), [pane]);

    const result = await (await actions(client)).movePaneToHost(pane, host, "/srv/app", []);

    expect(moveSession).toHaveBeenCalledWith("session-1", {
      host_id: host.id,
      // The folder chosen for it there, not wherever the shell happens to start.
      cwd: "/srv/app",
      // Where this device saw it, so a move from elsewhere that landed first
      // is refused rather than repeated.
      expected_host_id: "host-1",
      agent_session_id: null,
    });
    // Its tile, name and skills live on the window, so nothing is copied,
    // swapped or torn down to keep them.
    expect(createSession).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
    expect(result).toEqual(moved);
    // The caches say where it runs now, before any refetch answers.
    expect(client.getQueryData(qk.session("session-1"))).toEqual(moved);
  });

  test("starts the agent in a new conversation over there, queued for this device to type", async () => {
    const claude = makeAgent({
      id: "agent-claude",
      name: "claude-code",
      kind: "claude-code",
      command: "claude",
    });

    await (await actions()).movePaneToHost(
      makeSession({ ...pane, agent_id: claude.id, agent_session_id: "old-conversation" }),
      host,
      "/srv/app",
      [claude],
    );

    const body = (moveSession as jest.Mock).mock.calls[0]?.[1];
    expect(body.agent_session_id).toBe("0b0e7c1e-1111-4a2a-9c3c-5d6e7f809102");
    expect(pendingLaunches.persist).toHaveBeenCalledWith(
      "session-1",
      "claude --session-id 0b0e7c1e-1111-4a2a-9c3c-5d6e7f809102",
    );
  });

  test("relaunches an agent that names no conversation as itself", async () => {
    const codex = makeAgent({ command: "codex" });

    await (await actions()).movePaneToHost(
      makeSession({ ...pane, foreground_command: "codex" }),
      host,
      "/srv/app",
      [codex],
    );

    expect((moveSession as jest.Mock).mock.calls[0]?.[1].agent_session_id).toBeNull();
    expect(pendingLaunches.persist).toHaveBeenCalledWith("session-1", "codex");
  });

  test("says why a refused move left the window where it was, and queues nothing", async () => {
    (moveSession as jest.Mock).mockRejectedValue(
      new ApiError(409, "http_409", "move_conflict", "move_conflict"),
    );

    const move = (await actions()).movePaneToHost;
    await expect(move(pane, host, "/srv/app", [makeAgent()])).rejects.toThrow(
      "This window was moved from another device in the meantime, so it was left where it is now.",
    );
    expect(pendingLaunches.persist).not.toHaveBeenCalled();

    (moveSession as jest.Mock).mockRejectedValue(
      new ApiError(409, "http_409", "target_offline", "target_offline"),
    );
    await expect(move(pane, host, "/srv/app", [])).rejects.toThrow(
      "studio is offline, so the window stayed where it was.",
    );
  });
});
