import {
  createLaunchOrchestrator,
  type LaunchDependencies,
  type LauncherError,
  launchAvailability,
} from "@/components/launcher/launch-orchestrator";
import type { PendingLaunchStore } from "@/components/launcher/pending-launch";
import { fullTab, makeAgent, makeHost, makeSession, makeWorkspace } from "./fixtures";

function makePending(overrides: Partial<PendingLaunchStore> = {}): PendingLaunchStore {
  return {
    persist: async (sessionId, command) => ({
      sessionId,
      command,
      createdAt: 1,
      expiresAt: 2,
    }),
    take: async () => ({ status: "missing" }),
    complete: async () => undefined,
    abandon: async () => undefined,
    clear: async () => undefined,
    ...overrides,
  };
}

function makeDependencies(overrides: Partial<LaunchDependencies> = {}): LaunchDependencies {
  const workspace = makeWorkspace();
  return {
    getWorkspace: async () => workspace,
    patchWorkspace: async (_id, patch) => ({ ...workspace, layout: patch.layout }),
    createSession: async () => makeSession(),
    deleteSession: async () => undefined,
    pending: makePending(),
    ...overrides,
  };
}

describe("two-stage launch orchestration", () => {
  test("patches the target tab, creates a shell, then persists the constructed agent command", async () => {
    const events: string[] = [];
    let savedCommand: string | null = null;
    const session = makeSession();
    const pending = makePending({
      persist: async (sessionId, command) => {
        events.push(`persist:${sessionId}`);
        savedCommand = command;
        return { sessionId, command, createdAt: 1, expiresAt: 2 };
      },
    });
    const patchWorkspace = jest.fn<
      ReturnType<LaunchDependencies["patchWorkspace"]>,
      Parameters<LaunchDependencies["patchWorkspace"]>
    >(async (_id, patch) => {
      events.push("patch");
      return { ...makeWorkspace(), layout: patch.layout };
    });
    const createSession = jest.fn<
      ReturnType<LaunchDependencies["createSession"]>,
      Parameters<LaunchDependencies["createSession"]>
    >(async (input) => {
      events.push(`create:${input.host_id}:${input.cwd}`);
      return session;
    });
    const dependencies = makeDependencies({
      patchWorkspace,
      createSession,
      pending,
    });
    const orchestrator = createLaunchOrchestrator(dependencies);
    const result = await orchestrator.launch({
      workspaceId: makeWorkspace().id,
      tabId: "tab-1",
      hostId: makeHost().id,
      cwd: "/Users/ada/spawn",
      name: "  Native work  ",
      agent: makeAgent({ yolo: true }),
    });

    expect(result.status).toBe("launched");
    expect(events).toEqual([
      "patch",
      `create:${makeHost().id}:/Users/ada/spawn`,
      `persist:${session.id}`,
    ]);
    expect(patchWorkspace).toHaveBeenCalledWith(
      makeWorkspace().id,
      expect.objectContaining({
        layout: expect.objectContaining({ active_tab: "tab-1" }),
      }),
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: makeWorkspace().id,
        tile: expect.objectContaining({ x: 0, y: 0 }),
      }),
    );
    expect(savedCommand).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });

  test("reports an honest recoverable state when persistence fails after creation", async () => {
    const deleteSession = jest.fn(async () => undefined);
    const pending = makePending({
      persist: async () => {
        throw new Error("Secure storage unavailable");
      },
      clear: jest.fn(async () => undefined),
    });
    const orchestrator = createLaunchOrchestrator(makeDependencies({ pending, deleteSession }));
    const result = await orchestrator.launch({
      workspaceId: makeWorkspace().id,
      tabId: "tab-1",
      hostId: makeHost().id,
      cwd: "/Users/ada",
      agent: makeAgent(),
    });

    expect(result.status).toBe("created_unqueued");
    expect(deleteSession).not.toHaveBeenCalled();
    await orchestrator.discard(result.session.id);
    expect(pending.clear).toHaveBeenCalledWith(result.session.id);
    expect(deleteSession).toHaveBeenCalledWith(result.session.id);
  });

  test("still deletes a cancelled shell when pending-command cleanup fails", async () => {
    const deleteSession = jest.fn(async () => undefined);
    const orchestrator = createLaunchOrchestrator(
      makeDependencies({
        deleteSession,
        pending: makePending({
          clear: async () => {
            throw new Error("Keychain unavailable");
          },
        }),
      }),
    );
    await expect(orchestrator.discard(makeSession().id)).rejects.toThrow("Keychain unavailable");
    expect(deleteSession).toHaveBeenCalledWith(makeSession().id);
  });

  test("blocks a launch into a full tab before creating a session", async () => {
    const createSession = jest.fn(async () => makeSession());
    const workspace = makeWorkspace({
      layout: { version: 3, active_tab: "tab-1", tabs: [fullTab()] },
    });
    const orchestrator = createLaunchOrchestrator(
      makeDependencies({ getWorkspace: async () => workspace, createSession }),
    );
    await expect(
      orchestrator.launch({
        workspaceId: workspace.id,
        tabId: "tab-1",
        hostId: makeHost().id,
        cwd: "/Users/ada",
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<LauncherError>>({ code: "tab_full" }));
    expect(createSession).not.toHaveBeenCalled();
  });

  test("does not treat host telemetry or session row counts as quotas", () => {
    const tab = makeWorkspace().layout.tabs[0];
    expect(tab).toBeDefined();
    if (!tab) return;
    expect(
      launchAvailability(tab, makeHost({ cpu_bucket: 5, mem_bucket: 5, session_count: 99_999 })),
    ).toBeNull();
    expect(launchAvailability(tab, makeHost({ status: "offline" }))).toBe("host_offline");
    expect(launchAvailability(fullTab(), makeHost())).toBe("tab_full");
  });
});
