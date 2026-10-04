import { describe, expect, test } from "bun:test";
import { FakeHost, FakeHosts, FakeLauncher, FakeServer } from "./fakes";
import { MoveOrchestrator, type MovePlan } from "./orchestrator";
import {
  giveUpMove,
  type ResolvePorts,
  type ResolveRequest,
  resolveMove,
  takeWindowToConversation,
} from "./resolver";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const TRANSFER = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";
const BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const SHA256 = "a".repeat(64);

function setup({ incoming }: { incoming?: "committed" | "receiving" | null } = {}) {
  const source = new FakeHost(SOURCE);
  const target = new FakeHost(TARGET);
  const server = new FakeServer();
  server.online.add(SOURCE);
  server.online.add(TARGET);
  server.rows.set(SESSION, {
    host_id: SOURCE,
    status: "moving",
    exited: true,
    cwd: "/home/me/code/spawn",
    agent_session_id: CONVERSATION,
  });
  source.outgoing.set(TRANSFER, {
    conversationId: CONVERSATION,
    sessionId: SESSION,
    toHostId: TARGET,
    state: "held",
    bytes: BYTES,
    sha256: SHA256,
  });
  if (incoming) {
    target.incoming.set(TRANSFER, {
      conversationId: CONVERSATION,
      cwd: "/Users/me/code/spawn",
      length: BYTES.byteLength,
      chunks: incoming === "committed" ? [BYTES] : [BYTES.subarray(0, 8)],
      state: incoming,
      sha256: incoming === "committed" ? SHA256 : null,
      stream: null,
    });
  }
  const events: string[] = [];
  let prepared: { hostId: string; line: string | null } | null = null;
  let restartLine: string | null | undefined;
  const files = new Map<string, string>();
  const waits: number[] = [];
  const ports: ResolvePorts & { sleep: (ms: number) => Promise<void> } = {
    server,
    readText: async (_client, path) => files.get(path) ?? null,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    host: async (hostId: string) => {
      const host = hostId === SOURCE ? source : hostId === TARGET ? target : null;
      if (!host) throw new Error("no such host");
      return host.client();
    },
    launcher: {
      prepareOn: async (hostId: string, plan: { line: string } | null) => {
        events.push("prepare");
        prepared = { hostId, line: plan?.line ?? null };
      },
      abandon: () => events.push("abandon"),
      restartOnSource: async (line: string | null) => {
        events.push("restart");
        restartLine = line;
      },
      refetch: () => events.push("refetch"),
    },
  };
  const request: ResolveRequest = {
    sessionId: SESSION,
    source: { hostId: SOURCE, name: "dream", os: "linux" },
    hostById: (id) =>
      id === TARGET
        ? { hostId: TARGET, name: "mac", os: "darwin" }
        : id === SOURCE
          ? { hostId: SOURCE, name: "dream", os: "linux" }
          : null,
    cwd: "/home/me/code/spawn",
    agent: { kind: "claude-code", command: "claude", env: {} },
    conversationId: CONVERSATION,
    serverMoving: true,
  };
  return {
    source,
    target,
    server,
    ports,
    request,
    events,
    files,
    waits,
    prepared: () => prepared,
    restartLine: () => restartLine,
  };
}

describe("resolveMove", () => {
  test("committed on the target: the source retires it, the server commits, the resume is queued there", async () => {
    const { source, server, ports, request, events, prepared } = setup({ incoming: "committed" });
    const outcome = await resolveMove(request, ports);
    expect(outcome).toEqual({ kind: "finished", targetHostId: TARGET, archived: false });
    expect(source.outgoing.get(TRANSFER)?.state).toBe("retired");
    expect(server.rows.get(SESSION)).toMatchObject({ host_id: TARGET, status: "starting" });
    expect(events).toContain("prepare");
    expect(prepared()?.hostId).toBe(TARGET);
    expect(prepared()?.line).toBe(`claude --resume ${CONVERSATION} --permission-mode default`);
    // Not the mover: the source folder, home-relative, as the phone guesses it.
    expect(server.rows.get(SESSION)?.cwd).toBe("~/code/spawn");
  });

  test("a finished move resumes in the target's own default mode, and a yolo window in bypass", async () => {
    const first = setup({ incoming: "committed" });
    first.files.set("~/.claude/settings.json", '{"permissions":{"defaultMode":"acceptEdits"}}');
    await resolveMove(first.request, first.ports);
    expect(first.prepared()?.line).toBe(
      `claude --resume ${CONVERSATION} --permission-mode acceptEdits`,
    );
    const yolo = setup({ incoming: "committed" });
    yolo.files.set("~/.claude/settings.json", '{"permissions":{"defaultMode":"plan"}}');
    await resolveMove(
      {
        ...yolo.request,
        agent: {
          kind: "claude-code",
          command: "claude",
          env: {},
          yolo: true,
          yolo_args: "--dangerously-skip-permissions",
        },
      },
      yolo.ports,
    );
    expect(yolo.prepared()?.line).toBe(
      `claude --resume ${CONVERSATION} --permission-mode bypassPermissions`,
    );
  });

  test("the folder the mover picked is used when this browser knows it", async () => {
    const { server, ports, request } = setup({ incoming: "committed" });
    await resolveMove({ ...request, targetCwd: "/Users/me/work/spawn" }, ports);
    expect(server.rows.get(SESSION)?.cwd).toBe("/Users/me/work/spawn");
  });

  test("mid-copy: cancelled on the target first, then the source puts it back and the window restarts there", async () => {
    const { source, target, server, ports, request, events, restartLine } = setup({
      incoming: "receiving",
    });
    const outcome = await resolveMove(request, ports);
    expect(outcome).toEqual({ kind: "put_back", restarted: true, conflicts: false });
    expect(target.cancelled.has(TRANSFER)).toBe(true);
    expect(source.outgoing.get(TRANSFER)?.state).toBe("aborted");
    expect(source.conversationBytes(CONVERSATION)).toEqual(BYTES);
    expect(server.rows.get(SESSION)?.status).toBe("killed");
    expect(events).toContain("restart");
    expect(target.operations.indexOf("conv.import.cancel")).toBeGreaterThanOrEqual(0);
    // Whoever puts it back leaves Claude Code running there: the conversation
    // that was moving, in the mode it ran in there — the line names none, so
    // Claude Code restores the one its record carries.
    expect(restartLine()).toBe(`claude --resume ${CONVERSATION}`);
  });

  test("a put-back from another device names no mode, whatever the source's settings say, and is spelled for its shell", async () => {
    const { source, ports, request, files, restartLine } = setup({ incoming: "receiving" });
    source.loginShell = "/usr/bin/fish";
    // A default the person set on dream never overrides the mode the window
    // was in when it began to move.
    files.set("~/.claude/settings.json", JSON.stringify({ permissions: { defaultMode: "plan" } }));
    request.agent = { ...request.agent, env: { CLAUDE_CONFIG_DIR: "/home/me/Claude's" } };
    expect(await resolveMove(request, ports)).toMatchObject({ kind: "put_back", restarted: true });
    // fish quotes with a backslash where POSIX shells close and reopen.
    expect(restartLine()).toBe(
      `CLAUDE_CONFIG_DIR='/home/me/Claude\\'s' claude --resume ${CONVERSATION}`,
    );
    expect(source.operations).toContain("conv.probe");
  });

  test("a source that cannot say its shell still gets the line, as for POSIX", async () => {
    const { source, ports, request, restartLine } = setup({ incoming: "receiving" });
    source.loginShell = null;
    expect(await resolveMove(request, ports)).toMatchObject({ kind: "put_back", restarted: true });
    expect(restartLine()).toBe(`claude --resume ${CONVERSATION}`);
  });

  test("the target cannot be reached: nothing is guessed, the source keeps the files aside", async () => {
    const { source, target, server, ports, request } = setup({ incoming: "receiving" });
    target.goOffline();
    const outcome = await resolveMove(request, ports);
    expect(outcome).toEqual({ kind: "target_unreachable", targetHostId: TARGET });
    expect(source.outgoing.get(TRANSFER)?.state).toBe("held");
    expect(server.rows.get(SESSION)?.status).toBe("moving");
  });

  test("the source cannot be reached: unresolved", async () => {
    const { source, ports, request } = setup({ incoming: "receiving" });
    source.goOffline();
    expect(await resolveMove(request, ports)).toEqual({ kind: "source_unreachable" });
  });

  test("no transfer on the source, read again after the stop had time: the server's abort, and its answer says whether to restart", async () => {
    const { source, server, ports, request, events, waits, restartLine } = setup();
    source.outgoing.clear();
    const outcome = await resolveMove(request, ports);
    expect(outcome).toEqual({ kind: "put_back", restarted: true, conflicts: false });
    expect(server.rows.get(SESSION)?.status).toBe("killed");
    expect(events).toContain("restart");
    // No transfer names the conversation: the window's own record does.
    expect(restartLine()).toBe(`claude --resume ${CONVERSATION}`);
    // Never on one empty listing: waited out a window's stop, and asked again.
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(10_000);
    expect(source.operations.filter((op) => op === "conv.transfers").length).toBeGreaterThan(1);
    expect(source.operations.filter((op) => op === "conv.inspect")).toHaveLength(2);
  });

  test("no transfer yet, and its record lands while the resolver waits: resolved by the record, not aborted blind", async () => {
    const { source, target, server, ports, request } = setup({ incoming: "receiving" });
    const held = source.outgoing.get(TRANSFER);
    source.outgoing.clear();
    ports.sleep = async () => {
      if (held) source.outgoing.set(TRANSFER, held);
    };
    const outcome = await resolveMove(request, ports);
    expect(outcome).toEqual({ kind: "put_back", restarted: true, conflicts: false });
    expect(target.cancelled.has(TRANSFER)).toBe(true);
    expect(server.calls).toEqual(["abort"]);
  });

  test("no transfer, but the window stopped while the resolver watched: a retire may be under way, nothing is aborted", async () => {
    const { source, server, ports, request } = setup();
    source.outgoing.clear();
    source.windows.set(SESSION, { conversationId: CONVERSATION, running: true });
    ports.sleep = async () => {
      const window = source.windows.get(SESSION);
      if (window) window.running = false;
    };
    expect(await resolveMove(request, ports)).toEqual({ kind: "source_busy" });
    expect(server.calls).toEqual([]);
    expect(server.rows.get(SESSION)?.status).toBe("moving");
  });

  test("no transfer, and the source cannot say whether it runs the window: nothing is aborted", async () => {
    const { source, server, ports, request } = setup();
    source.outgoing.clear();
    source.faults.refuse = { "conv.inspect": "too_many_tasks" };
    expect(await resolveMove(request, ports)).toEqual({ kind: "source_busy" });
    expect(server.calls).toEqual([]);
  });

  test("no transfer and nothing stopped: running again, nothing restarted", async () => {
    const { source, server, ports, request, events } = setup();
    source.outgoing.clear();
    const row = server.rows.get(SESSION);
    if (row) row.exited = false;
    const outcome = await resolveMove(request, ports);
    expect(outcome).toEqual({ kind: "put_back", restarted: false, conflicts: false });
    expect(events).not.toContain("restart");
  });

  test("a target whose cancel does not say 'cancelled' is not taken as cancelled", async () => {
    const { source, target, server, ports, request } = setup({ incoming: "receiving" });
    target.faults.cancelAnswer = "receiving";
    expect(await resolveMove(request, ports)).toEqual({
      kind: "target_unreachable",
      targetHostId: TARGET,
    });
    expect(source.outgoing.get(TRANSFER)?.state).toBe("held");
    expect(server.calls).toEqual([]);
  });

  test("committed there, and the move was put back underneath: begun again and finished", async () => {
    const { server, ports, request } = setup({ incoming: "committed" });
    let once = false;
    server.beforeCommit = () => {
      const row = server.rows.get(SESSION);
      if (once || row?.status !== "moving") return;
      once = true;
      row.status = "killed";
    };
    const outcome = await resolveMove(request, ports);
    expect(outcome).toEqual({ kind: "finished", targetHostId: TARGET, archived: false });
    expect(server.rows.get(SESSION)).toMatchObject({ host_id: TARGET, status: "starting" });
    expect(server.calls.filter((call) => call === "begin")).toHaveLength(1);
  });

  test("committed there, and the mover committed first: finished, nothing typed by this device", async () => {
    const { server, ports, request, events } = setup({ incoming: "committed" });
    server.beforeCommit = () => {
      const row = server.rows.get(SESSION);
      if (row?.status === "moving") Object.assign(row, { host_id: TARGET, status: "starting" });
    };
    const outcome = await resolveMove(request, ports);
    expect(outcome).toEqual({ kind: "finished", targetHostId: TARGET, archived: false });
    expect(events.at(-1)).not.toBe("prepare");
    expect(events).toContain("abandon");
  });

  test("committed there and the window cannot follow: said plainly, and taken there on request", async () => {
    const { server, ports, request, prepared } = setup({ incoming: "committed" });
    server.beforeCommit = () => {
      const row = server.rows.get(SESSION);
      if (row?.status === "moving") row.status = "killed";
    };
    server.failNext.begin = [{ status: 409, detail: "source_offline" }];
    const outcome = await resolveMove(request, ports);
    expect(outcome).toEqual({
      kind: "on_target",
      targetHostId: TARGET,
      cwd: "~/code/spawn",
      conversationId: CONVERSATION,
    });
    if (outcome.kind !== "on_target") return;
    const taken = await takeWindowToConversation(
      {
        sessionId: SESSION,
        source: request.source,
        agent: request.agent,
        target: { hostId: TARGET, name: "mac", os: "darwin" },
        cwd: outcome.cwd,
        conversationId: outcome.conversationId,
      },
      ports,
    );
    expect(taken).toEqual({ kind: "finished", targetHostId: TARGET, archived: false });
    expect(server.rows.get(SESSION)).toMatchObject({ host_id: TARGET, cwd: "~/code/spawn" });
    expect(prepared()?.line).toStartWith(`claude --resume ${CONVERSATION} --permission-mode`);
  });

  test("a stranded transfer only aborts, and files in the way are reported", async () => {
    const { source, ports, request } = setup();
    const outgoing = source.outgoing.get(TRANSFER);
    if (outgoing) outgoing.state = "stranded";
    source.faults.abortAlreadyExists = true;
    const outcome = await resolveMove(request, ports);
    expect(outcome).toEqual({ kind: "put_back", restarted: true, conflicts: true });
  });

  test("another device settled it first: the server's conflict is not fought", async () => {
    const { server, ports, request } = setup({ incoming: "receiving" });
    server.failNext.abort = [{ status: 409, detail: "move_conflict" }];
    expect(await resolveMove(request, ports)).toEqual({ kind: "elsewhere" });
  });

  test("the host cockpit settles a leftover transfer without touching the server", async () => {
    const { source, server, ports, request } = setup({ incoming: "receiving" });
    const outcome = await resolveMove(
      { ...request, serverMoving: false, transferId: TRANSFER },
      ports,
    );
    expect(outcome).toEqual({ kind: "put_back", restarted: false, conflicts: false });
    expect(source.outgoing.get(TRANSFER)?.state).toBe("aborted");
    expect(server.calls).toEqual([]);
  });

  test("giving up without the source ends the server's move only", async () => {
    const { server, request } = setup();
    expect(await giveUpMove(request, server)).toEqual({ kind: "given_up" });
    expect(server.rows.get(SESSION)?.status).toBe("killed");
  });
});

describe("resolveMove racing a live mover on another device", () => {
  test("Resolve pressed just as the mover begins: the resolver waits out the stop, and both devices end with one consistent story", async () => {
    const { source, target, server, ports, request } = setup();
    source.outgoing.clear();
    const bytes = Uint8Array.from({ length: 8 * 30 }, (_, index) => index % 251);
    source.conversations.set(CONVERSATION, { cwd: "/home/me/code/spawn", bytes });
    source.windows.set(SESSION, { conversationId: CONVERSATION, running: true });
    Object.assign(server.rows.get(SESSION) ?? {}, { status: "running", exited: false });
    source.onWindowStopped = (id) => server.windowExited(id);
    const plan: MovePlan = {
      transferId: TRANSFER,
      sessionId: SESSION,
      agent: { kind: "claude-code", command: "claude", env: {} },
      conversationId: CONVERSATION,
      source: { hostId: SOURCE, name: "dream", os: "linux", cwd: "/home/me/code/spawn" },
      target: { hostId: TARGET, name: "mac", os: "darwin", cwd: "/Users/me/code/spawn" },
      state: "idle",
      permissionMode: "default",
      targetShell: "/bin/zsh",
      memoryPath: null,
      wasRunning: true,
    };
    await server.begin(SESSION, SOURCE);
    const mover = new MoveOrchestrator(plan, {
      server,
      hosts: new FakeHosts(source, target),
      launcher: new FakeLauncher(),
      sleep: async () => {},
    });
    // The other device's carry runs while the resolver waits for the stop.
    let carried: Promise<void> | null = null;
    ports.sleep = async () => {
      carried ??= (mover as unknown as { carry(): Promise<void> }).carry();
      await carried;
    };
    const outcome = await resolveMove(request, ports);
    await carried;
    // The mover finished; the resolver saw the window stop and aborted nothing.
    expect(outcome).toEqual({ kind: "source_busy" });
    expect(mover.getView()).toMatchObject({ phase: "moved", outcome: "moved" });
    expect(server.rows.get(SESSION)).toMatchObject({ host_id: TARGET, status: "starting" });
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
    expect(server.calls).not.toContain("abort");
  });
});

describe("resolveMove from a host's page", () => {
  test("a transfer names its window: the server's move is settled too", async () => {
    const { server, ports, request } = setup({ incoming: "receiving" });
    const outcome = await resolveMove(
      {
        ...request,
        sessionId: "",
        serverMoving: false,
        transferId: TRANSFER,
        windowOf: (id) => (id === SESSION ? { cwd: "/home/me/code/spawn", moving: true } : null),
      },
      ports,
    );
    expect(outcome).toEqual({ kind: "put_back", restarted: true, conflicts: false });
    expect(server.calls).toEqual(["abort"]);
  });
});
