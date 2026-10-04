import { describe, expect, test } from "bun:test";
import { FakeHost, FakeHosts, FakeLauncher, FakeServer } from "./fakes";
import { MoveOrchestrator, type MovePlan, type MovePorts, type MoveView } from "./orchestrator";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const TRANSFER = "44444444-4444-4444-8444-444444444444";
const CONVERSATION = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";

function conversation(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 7 + 3) % 251);
}

function setup({
  length = 100,
  running = true,
  state = "running" as MovePlan["state"],
  targetShell = "/bin/zsh" as string | null,
  readText = undefined as MovePorts["readText"],
  yolo = false,
} = {}) {
  const source = new FakeHost(SOURCE);
  const target = new FakeHost(TARGET);
  const bytes = conversation(length);
  source.conversations.set(CONVERSATION, { cwd: "/home/me/code/spawn", bytes });
  source.windows.set(SESSION, { conversationId: CONVERSATION, running });
  const server = new FakeServer();
  server.online.add(SOURCE);
  server.online.add(TARGET);
  server.rows.set(SESSION, {
    host_id: SOURCE,
    status: running ? "running" : "killed",
    exited: !running,
    cwd: "/home/me/code/spawn",
    agent_session_id: CONVERSATION,
  });
  source.onWindowStopped = (id) => server.windowExited(id);
  const hosts = new FakeHosts(source, target);
  const launcher = new FakeLauncher();
  const views: MoveView[] = [];
  const plan: MovePlan = {
    transferId: TRANSFER,
    sessionId: SESSION,
    agent: {
      kind: "claude-code",
      command: "claude",
      env: {},
      ...(yolo ? { yolo: true, yolo_args: "--dangerously-skip-permissions" } : {}),
    },
    conversationId: CONVERSATION,
    source: { hostId: SOURCE, name: "dream", os: "linux", cwd: "/home/me/code/spawn" },
    target: { hostId: TARGET, name: "mac", os: "darwin", cwd: "/Users/me/code/spawn" },
    state,
    permissionMode: "default",
    targetShell,
    memoryPath: "~/.claude/projects/-Users-me-code-spawn/memory",
    wasRunning: running,
  };
  const move = new MoveOrchestrator(
    plan,
    { server, hosts, launcher, sleep: async () => {}, ...(readText ? { readText } : {}) },
    (view) => views.push(view),
  );
  return { source, target, server, hosts, launcher, views, move, bytes, plan };
}

function phases(views: MoveView[]): string[] {
  return views.map((view) => view.phase).filter((phase, index, all) => phase !== all[index - 1]);
}

describe("a move that goes through", () => {
  test("a running conversation lands on the target, retired on the source, with its note on the line", async () => {
    const { move, source, target, server, launcher, views, bytes } = setup();
    await move.start();
    const view = move.getView();
    expect(view.phase).toBe("moved");
    expect(view.outcome).toBe("moved");
    expect(phases(views)).toEqual(["starting", "stopping", "copying", "finishing", "moved"]);
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
    expect(source.conversationBytes(CONVERSATION)).toBeUndefined();
    expect(source.outgoing.get(TRANSFER)?.state).toBe("retired");
    expect(server.rows.get(SESSION)).toMatchObject({
      host_id: TARGET,
      status: "starting",
      agent_session_id: CONVERSATION,
      cwd: "/Users/me/code/spawn",
    });
    expect(server.calls).toEqual(["begin", "commit"]);
    // Every resume carries an explicit mode, and a running agent's note
    // rides the line as its first prompt in a POSIX shell on macOS.
    expect(launcher.prepared?.line).toStartWith(
      `claude --resume ${CONVERSATION} --permission-mode default '[SPAWN D] This conversation just moved from dream (Linux) to mac (macOS)`,
    );
    expect(launcher.prepared?.note?.delivery).toBe("positional");
    expect(launcher.events).toEqual(["prepare", "refetch"]);
    expect(views.at(-1)?.bytes).toBe(bytes.byteLength);
  });

  test("an idle conversation resumes plainly and its note is typed, never sent", async () => {
    const { move, launcher } = setup({ state: "idle" });
    await move.start();
    expect(move.getView().outcome).toBe("moved");
    expect(launcher.prepared?.line).toBe(
      `claude --resume ${CONVERSATION} --permission-mode default`,
    );
    expect(launcher.prepared?.note?.delivery).toBe("typed_no_enter");
    expect(launcher.prepared?.note?.text).toStartWith("[SPAWN D: moved from dream (Linux)");
  });

  test("a blocked conversation on a shell SPAWN D cannot quote for has its note typed after the prompt", async () => {
    const { move, launcher } = setup({ state: "blocked", targetShell: "/usr/bin/nu" });
    await move.start();
    expect(launcher.prepared?.note?.delivery).toBe("typed");
    expect(launcher.prepared?.line).toBe(
      `claude --resume ${CONVERSATION} --permission-mode default`,
    );
  });

  test("a stopped window moves too, and nothing claims the retire stopped it", async () => {
    const { move, target, bytes } = setup({ running: false, state: "unknown" });
    await move.start();
    expect(move.getView().outcome).toBe("moved");
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
  });

  test("a conversation many windows long keeps to both windows and every chunk lands once", async () => {
    const { move, source, target, bytes } = setup({ length: 8 * 200 + 3 });
    await move.start();
    expect(move.getView().outcome).toBe("moved");
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
    expect(target.takenChunks).toBe(201);
    expect(source.sentChunks).toBe(201);
  });
});

describe("a lost channel resumes the same transfer", () => {
  test("the source's channel goes mid-carry: the export resumes where the target stands", async () => {
    const { move, source, target, hosts, bytes } = setup({ length: 8 * 60 });
    source.faults.loseAfterSentChunks = 20;
    await move.start();
    expect(move.getView().outcome).toBe("moved");
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
    expect(hosts.opened.source).toBeGreaterThanOrEqual(2);
    // The target never took a chunk twice: it was asked where it stood.
    expect(target.takenChunks).toBe(60);
    expect(target.operations).toContain("conv.import.status");
  });

  test("the target's channel goes mid-carry: the begin is repeated and the pump goes on", async () => {
    const { move, target, hosts, bytes } = setup({ length: 8 * 60 });
    target.faults.loseAfterTakenChunks = 25;
    await move.start();
    expect(move.getView().outcome).toBe("moved");
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
    expect(hosts.opened.target).toBeGreaterThanOrEqual(2);
  });

  test("the commit's own frame is lost: the status says committed and the move finishes", async () => {
    const { move, source, target, server } = setup();
    target.faults.loseCommitFrame = true;
    await move.start();
    expect(move.getView().outcome).toBe("moved");
    expect(target.operations).toContain("conv.import.status");
    expect(source.outgoing.get(TRANSFER)?.state).toBe("retired");
    expect(server.rows.get(SESSION)?.host_id).toBe(TARGET);
  });

  test("an export whose answer never came is asked again under the same transfer id", async () => {
    const { move, source, bytes, target } = setup();
    source.faults.vanishOn = new Set(["conv.export"]);
    await move.start();
    expect(move.getView().outcome).toBe("moved");
    expect(source.operations.filter((op) => op === "conv.export")).toHaveLength(1);
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
  });

  test("a channel that keeps going pauses for the person, who can try again", async () => {
    const { move, source, target, bytes } = setup({ length: 8 * 40 });
    source.goOffline();
    await move.start();
    expect(move.getView()).toMatchObject({
      phase: "paused",
      failure: "connection_lost",
      actions: ["retry", "resume_source"],
    });
    source.online = true;
    await move.retry();
    expect(move.getView().outcome).toBe("moved");
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
  });
});

describe("the source refuses before anything moves", () => {
  test("live elsewhere: nothing was stopped, the server's abort says running, nothing is restarted", async () => {
    const { move, source, server, launcher } = setup();
    source.heldElsewhere.add(CONVERSATION);
    await move.start();
    expect(move.getView()).toMatchObject({
      phase: "ended",
      outcome: "put_back",
      failure: "conversation_live_elsewhere",
    });
    expect(move.getView().detail).toContain("stale record");
    expect(server.rows.get(SESSION)?.status).toBe("running");
    expect(launcher.events).not.toContain("restart");
    expect(source.conversationBytes(CONVERSATION)).toBeDefined();
  });

  test("restarted while it moved: window_restarted ends the move", async () => {
    const { move, source } = setup();
    source.faults.refuse = { "conv.export": "window_restarted" };
    await move.start();
    expect(move.getView()).toMatchObject({ phase: "ended", failure: "window_restarted" });
  });

  test("no stop confirmation: agent_still_running puts it back and offers to try again", async () => {
    const { move, source } = setup();
    source.faults.refuse = { "conv.export": "agent_still_running" };
    await move.start();
    expect(move.getView()).toMatchObject({
      phase: "ended",
      failure: "agent_still_running",
      actions: ["retry"],
    });
  });

  test("another move of the same conversation is unresolved: transfer_unresolved", async () => {
    const { move, source } = setup();
    source.faults.refuse = { "conv.export": "transfer_unresolved" };
    await move.start();
    expect(move.getView().failure).toBe("transfer_unresolved");
  });
});

describe("the target refuses", () => {
  test("live here at the begin: paused, and once Claude there is closed the move goes through", async () => {
    const { move, target, bytes } = setup();
    target.liveHere.add(CONVERSATION);
    await move.start();
    expect(move.getView()).toMatchObject({ phase: "paused", failure: "conversation_live_here" });
    target.liveHere.delete(CONVERSATION);
    await move.retry();
    expect(move.getView().outcome).toBe("moved");
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
  });

  test("live here at stream.end: the staging is kept and a retry only ends the stream", async () => {
    const { move, target, source } = setup({ length: 8 * 30 });
    target.faults.endError = "conversation_live_here";
    await move.start();
    expect(move.getView()).toMatchObject({ phase: "paused", failure: "conversation_live_here" });
    const sentBefore = source.sentChunks;
    await move.retry();
    expect(move.getView().outcome).toBe("moved");
    // Every chunk was already staged: the resumed export sent only its end.
    expect(source.sentChunks).toBe(sentBefore);
  });

  test("bytes that fail their digest are carried again from the first", async () => {
    const { move, target, bytes } = setup({ length: 8 * 10 });
    target.faults.endError = "integrity_mismatch";
    await move.start();
    expect(move.getView()).toMatchObject({ phase: "paused", failure: "integrity_mismatch" });
    await move.retry();
    expect(move.getView().outcome).toBe("moved");
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
  });

  test("a folder the target lacks pauses the move with its reason", async () => {
    const { move, target } = setup();
    target.folderExists = false;
    await move.start();
    expect(move.getView()).toMatchObject({ phase: "paused", failure: "folder_missing" });
  });
});

describe("putting a move back", () => {
  test("cancel mid-copy: target cancelled first, then the source puts the files back, then the server", async () => {
    const { move, source, target, server, launcher, bytes } = setup({ length: 8 * 400 });
    const started = move.start();
    // Let the copy get going, then cancel.
    while (move.getView().phase !== "copying") await new Promise((r) => setTimeout(r, 0));
    await move.cancel();
    await started;
    expect(move.getView()).toMatchObject({
      phase: "ended",
      outcome: "put_back_restarted",
      failure: "cancelled",
    });
    expect(target.cancelled.has(TRANSFER)).toBe(true);
    expect(source.outgoing.get(TRANSFER)?.state).toBe("aborted");
    expect(source.conversationBytes(CONVERSATION)).toEqual(bytes);
    const order = [...target.operations, ...source.operations];
    expect(order.indexOf("conv.import.cancel")).toBeGreaterThanOrEqual(0);
    expect(server.rows.get(SESSION)?.status).toBe("killed");
    expect(launcher.events).toContain("restart");
    // Claude Code comes back in the conversation that was moving, its mode
    // said outright — never the mode its record ran in.
    expect(launcher.restartLine).toBe(`claude --resume ${CONVERSATION} --permission-mode default`);
  });

  test("a put-back resumes in the source's own default mode, or bypass for a yolo window", async () => {
    const settings = new Map([
      ["~/.claude/settings.json", JSON.stringify({ permissions: { defaultMode: "acceptEdits" } })],
    ]);
    const { move, launcher } = setup({
      length: 8 * 400,
      readText: async (_client, path) => settings.get(path) ?? null,
    });
    const started = move.start();
    while (move.getView().phase !== "copying") await new Promise((r) => setTimeout(r, 0));
    await move.cancel();
    await started;
    expect(launcher.restartLine).toBe(
      `claude --resume ${CONVERSATION} --permission-mode acceptEdits`,
    );

    const yolo = setup({ length: 8 * 400, yolo: true });
    const going = yolo.move.start();
    while (yolo.move.getView().phase !== "copying") await new Promise((r) => setTimeout(r, 0));
    await yolo.move.cancel();
    await going;
    expect(yolo.launcher.restartLine).toBe(
      `claude --resume ${CONVERSATION} --permission-mode bypassPermissions`,
    );
  });

  test("a lingering worker reports no exit: the abort says running, and the device restarts all the same", async () => {
    const { move, source, server, launcher } = setup({ length: 8 * 400 });
    source.faults.lingering = true;
    const started = move.start();
    while (move.getView().phase !== "copying") await new Promise((r) => setTimeout(r, 0));
    await move.cancel();
    await started;
    expect(server.rows.get(SESSION)?.status).toBe("running");
    expect(move.getView().outcome).toBe("put_back_restarted");
    expect(launcher.events).toContain("restart");
  });

  test("a window stopped before the move stays stopped when the move is put back", async () => {
    const { move, target, launcher } = setup({ running: false, state: "unknown" });
    target.folderExists = false;
    await move.start();
    await move.resumeOnSource();
    expect(move.getView().outcome).toBe("put_back_stopped");
    expect(launcher.events).not.toContain("restart");
  });

  test("files in the way of the put-back are reported, for the person to resolve", async () => {
    const { move, source, target } = setup();
    target.folderExists = false;
    source.faults.abortAlreadyExists = true;
    await move.start();
    await move.resumeOnSource();
    expect(move.getView()).toMatchObject({ phase: "ended", conflicts: true });
  });

  test("a target that cannot say cancelled keeps the source's files aside: unresolved, for Resolve", async () => {
    const { move, source, target, server } = setup({ length: 8 * 60 });
    target.faults.loseAfterTakenChunks = 10;
    const started = move.start();
    while (target.takenChunks < 10) await new Promise((r) => setTimeout(r, 0));
    target.goOffline();
    await started;
    expect(move.getView()).toMatchObject({ phase: "paused", failure: "connection_lost" });
    await move.resumeOnSource();
    expect(move.getView()).toMatchObject({
      phase: "ended",
      outcome: "unresolved",
      failure: "unresolved_target",
      actions: ["resolve"],
    });
    expect(source.outgoing.get(TRANSFER)?.state).toBe("held");
    expect(server.rows.get(SESSION)?.status).toBe("moving");
  });

  test("the source gone offline: the server's move is not aborted until it can put the conversation back", async () => {
    const { move, source, target, server } = setup({ length: 8 * 60 });
    source.faults.loseAfterSentChunks = 10;
    const started = move.start();
    while (source.sentChunks < 10) await new Promise((r) => setTimeout(r, 0));
    source.goOffline();
    await started;
    expect(move.getView().phase).toBe("paused");
    await move.resumeOnSource();
    expect(target.cancelled.has(TRANSFER)).toBe(true);
    expect(move.getView()).toMatchObject({ outcome: "unresolved", failure: "unresolved_source" });
    expect(server.calls).not.toContain("abort");
    expect(server.rows.get(SESSION)?.status).toBe("moving");
  });

  test("an abort another device beat is not fought: the move ended elsewhere", async () => {
    const { move, target, server } = setup();
    target.folderExists = false;
    await move.start();
    server.failNext.abort = [{ status: 409, detail: "move_conflict" }];
    await move.resumeOnSource();
    expect(move.getView()).toMatchObject({ outcome: "elsewhere", failure: "resolved_elsewhere" });
  });

  test("an abort the server does not take is said as the server's, never blamed on the source", async () => {
    const { move, source, target, server } = setup();
    target.folderExists = false;
    await move.start();
    server.failNext.abort = [{ status: 0 }];
    await move.resumeOnSource();
    expect(move.getView()).toMatchObject({
      phase: "ended",
      outcome: "unresolved",
      failure: "abort_failed",
      actions: ["resolve"],
    });
    expect(server.rows.get(SESSION)?.status).toBe("moving");
    // The source has its files back; only the server's move is left, for
    // Resolve.
    expect(source.outgoing.get(TRANSFER)?.state).not.toBe("held");
  });

  test("an import another device cancelled ends this device's carry", async () => {
    const { move, target } = setup({ length: 8 * 200 });
    const started = move.start();
    while (target.takenChunks < 5) await new Promise((r) => setTimeout(r, 0));
    await target.client().request("conv.import.cancel", { transfer_id: TRANSFER });
    await started;
    expect(move.getView()).toMatchObject({ outcome: "elsewhere", failure: "resolved_elsewhere" });
  });
});

describe("a resolver racing this move (another device's Resolve)", () => {
  test("aborted underneath while the source stopped the window: begun again and finished — never 'resolved elsewhere'", async () => {
    // The reviewers' interleaving: the resolver lists conv.transfers before
    // the source has written its record, finds nothing, and aborts the
    // server's move. The carry goes on and the target commits.
    const { move, source, target, server, launcher, bytes } = setup();
    source.onWindowStopped = (id) => {
      server.windowExited(id);
      void server.abort(SESSION, SOURCE);
    };
    await move.start();
    expect(move.getView()).toMatchObject({ phase: "moved", outcome: "moved", failure: null });
    expect(server.rows.get(SESSION)).toMatchObject({ host_id: TARGET, status: "starting" });
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
    expect(source.outgoing.get(TRANSFER)?.state).toBe("retired");
    expect(server.calls.filter((call) => call === "begin")).toHaveLength(2);
    expect(launcher.queued).toBe(true);
  });

  test("aborted underneath and the source gone: it says the conversation is on the target and takes the window there", async () => {
    const { move, source, target, server, launcher, bytes } = setup();
    source.onWindowStopped = (id) => {
      server.windowExited(id);
      void server.abort(SESSION, SOURCE);
    };
    server.failNext.begin = [];
    const begin = server.begin.bind(server);
    let begins = 0;
    server.begin = async (...args) => {
      begins += 1;
      if (begins === 2)
        throw Object.assign(new Error("source_offline"), { status: 409, detail: "source_offline" });
      return begin(...args);
    };
    await move.start();
    expect(move.getView()).toMatchObject({
      phase: "ended",
      outcome: "on_target",
      failure: "conversation_on_target",
      actions: ["take_there"],
    });
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
    expect(launcher.queued).toBe(false);
    await move.takeThere();
    expect(move.getView()).toMatchObject({ phase: "moved", outcome: "moved" });
    expect(server.rows.get(SESSION)).toMatchObject({
      host_id: TARGET,
      agent_session_id: CONVERSATION,
      cwd: "/Users/me/code/spawn",
    });
    expect(server.calls).toContain("fresh");
    expect(launcher.queued).toBe(true);
    expect(launcher.prepared?.line).toStartWith(
      `claude --resume ${CONVERSATION} --permission-mode default`,
    );
  });
});

describe("hosts that answer badly", () => {
  test("a target whose cancel does not say 'cancelled' keeps the source's files aside", async () => {
    const { move, source, target, server } = setup();
    target.folderExists = false;
    await move.start();
    target.faults.cancelAnswer = "receiving";
    await move.resumeOnSource();
    expect(move.getView()).toMatchObject({ outcome: "unresolved", failure: "unresolved_target" });
    expect(source.outgoing.get(TRANSFER)?.state).toBe("held");
    expect(server.calls).not.toContain("abort");
  });

  test("an export refused with its transfer left stranded is put back in order, and the window restarted", async () => {
    const { move, source, target, server, launcher, bytes } = setup();
    source.faults.strandWith = "window_restarted";
    await move.start();
    expect(move.getView()).toMatchObject({
      phase: "ended",
      failure: "window_restarted",
      outcome: "put_back_restarted",
    });
    expect(target.cancelled.has(TRANSFER)).toBe(true);
    expect(source.outgoing.get(TRANSFER)?.state).toBe("aborted");
    expect(source.conversationBytes(CONVERSATION)).toEqual(bytes);
    expect(server.rows.get(SESSION)?.status).toBe("killed");
    expect(launcher.events).toContain("restart");
  });

  test("a stranded export whose target cannot say 'cancelled' is left for Resolve, files aside", async () => {
    const { move, source, target, server } = setup();
    source.faults.strandWith = "conversation_live_elsewhere";
    // The target goes as the source stops Claude, before the refusal.
    source.onWindowStopped = (id) => {
      server.windowExited(id);
      target.goOffline();
    };
    await move.start();
    expect(move.getView()).toMatchObject({ outcome: "unresolved", failure: "unresolved_target" });
    expect(source.outgoing.get(TRANSFER)?.state).toBe("stranded");
    expect(server.rows.get(SESSION)?.status).toBe("moving");
  });

  test("cancel while the source stops Claude: the retire's answer is still taken, the channel stays up, and it is put back", async () => {
    const { move, source, target, server, bytes } = setup({ length: 8 * 40 });
    source.onWindowStopped = (id) => {
      server.windowExited(id);
      void move.cancel();
    };
    await move.start();
    expect(move.getView()).toMatchObject({
      phase: "ended",
      outcome: "put_back_restarted",
      failure: "cancelled",
    });
    expect(source.channels.some((channel) => channel.lost)).toBe(false);
    expect(target.cancelled.has(TRANSFER)).toBe(true);
    expect(source.outgoing.get(TRANSFER)?.state).toBe("aborted");
    expect(source.conversationBytes(CONVERSATION)).toEqual(bytes);
  });

  test("cancel before the carry has opened anything: put back without carrying", async () => {
    const { move, target, views } = setup();
    let cancelled = false;
    const started = move.start();
    while (move.getView().phase !== "stopping") await new Promise((r) => setTimeout(r, 0));
    if (!cancelled) {
      cancelled = true;
      await move.cancel();
    }
    await started;
    expect(move.getView()).toMatchObject({ phase: "ended", failure: "cancelled" });
    expect(target.takenChunks).toBe(0);
    expect(views.some((view) => view.phase === "copying")).toBe(false);
  });

  test("a chunk sent on a channel that has just gone is a lost connection, resumed — not a failed copy", async () => {
    const { move, target, hosts, bytes } = setup({ length: 8 * 60 });
    target.faults.throwOnSendAfter = 20;
    await move.start();
    expect(move.getView().outcome).toBe("moved");
    expect(target.conversationBytes(CONVERSATION)).toEqual(bytes);
    expect(hosts.opened.target).toBeGreaterThanOrEqual(2);
  });
});

describe("the server's side", () => {
  test("the source offline at begin: nothing changed, a fresh start is offered", async () => {
    const { move, server, source } = setup();
    server.online.delete(SOURCE);
    await move.start();
    expect(move.getView()).toMatchObject({
      phase: "ended",
      outcome: "untouched",
      failure: "source_offline",
      actions: ["start_fresh"],
    });
    expect(source.operations).toEqual([]);
  });

  test.each([
    ["move_in_progress", 409, "move_in_progress"],
    ["move_conflict", 409, "move_conflict"],
    ["workspace_archived", 409, "workspace_archived"],
    [undefined, 404, "gone"],
  ] as const)("a begin refused with %s ends before anything stops", async (detail, status, failure) => {
    const { move, server, source } = setup();
    server.failNext.begin = [{ status, ...(detail ? { detail } : {}) }];
    await move.start();
    expect(move.getView()).toMatchObject({ phase: "ended", outcome: "untouched", failure });
    expect(source.operations).toEqual([]);
  });

  test("the target offline at the commit: retried, then paused with only Try again — never aborted", async () => {
    const { move, server, target, launcher } = setup();
    server.online.delete(TARGET);
    await move.start();
    expect(move.getView()).toMatchObject({
      phase: "paused",
      failure: "commit_target_offline",
      actions: ["retry"],
    });
    expect(server.calls.filter((call) => call === "commit")).toHaveLength(4);
    expect(server.calls).not.toContain("abort");
    expect(launcher.queued).toBe(false);
    // Cancel is refused once the target committed.
    await move.cancel();
    expect(move.getView().phase).toBe("paused");
    server.online.add(TARGET);
    await move.retry();
    expect(move.getView().outcome).toBe("moved");
    expect(target.conversationBytes(CONVERSATION)).toBeDefined();
    expect(launcher.queued).toBe(true);
  });

  test("a commit that timed out is tried again and lands", async () => {
    const { move, server } = setup();
    server.failNext.commit = [{ status: 0 }];
    await move.start();
    expect(move.getView().outcome).toBe("moved");
    expect(server.calls.filter((call) => call === "commit")).toHaveLength(2);
  });

  test("a commit another device finished first (the row is on the target): moved, nothing typed here", async () => {
    const { move, server, launcher } = setup();
    server.beforeCommit = () => {
      const row = server.rows.get(SESSION);
      if (row && row.status === "moving")
        Object.assign(row, { host_id: TARGET, status: "starting" });
    };
    await move.start();
    expect(move.getView()).toMatchObject({ phase: "moved", outcome: "moved" });
    expect(launcher.queued).toBe(false);
    expect(server.calls).toContain("get");
  });

  test("a commit that landed with its answer lost: refused on retry, read again, its relaunch kept", async () => {
    const { move, server, launcher } = setup();
    const commit = server.commit.bind(server);
    let lost = false;
    server.commit = async (...args) => {
      const answer = await commit(...args);
      if (!lost) {
        lost = true;
        throw Object.assign(new Error("Failed to fetch"), { status: 0 });
      }
      return answer;
    };
    await move.start();
    expect(move.getView()).toMatchObject({ phase: "moved", outcome: "moved" });
    expect(server.rows.get(SESSION)?.host_id).toBe(TARGET);
    expect(launcher.queued).toBe(true);
  });
  test("the window closed before the launch went out (404): moved, nothing typed", async () => {
    const { move, server, launcher } = setup();
    server.failNext.commit = [{ status: 404 }];
    await move.start();
    expect(move.getView().outcome).toBe("moved_gone");
    expect(launcher.queued).toBe(false);
  });

  test("an archived workspace takes the window stopped: moved, nothing typed", async () => {
    const { move, server, launcher } = setup();
    const commit = server.commit.bind(server);
    server.commit = async (...args) => {
      await commit(...args);
      const row = server.rows.get(SESSION);
      if (row) row.status = "killed";
      return { status: "killed" };
    };
    await move.start();
    expect(move.getView().outcome).toBe("moved_archived");
    expect(launcher.queued).toBe(false);
  });

  test("the source's retire commit fails: the window still moves, the source keeps it aside for Resolve", async () => {
    const { move, source, server } = setup();
    source.faults.refuse = { "conv.retire.commit": "too_many_tasks" };
    await move.start();
    expect(move.getView().outcome).toBe("moved");
    expect(server.rows.get(SESSION)?.host_id).toBe(TARGET);
    expect(source.outgoing.get(TRANSFER)?.state).toBe("held");
  });
});
