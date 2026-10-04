import { MoveRun, previewMove } from "@/components/workspace-detail/move-conversation";
import * as copy from "@/components/workspace-detail/move-copy";
import {
  giveUpMove,
  guessTargetCwd,
  resolveMove,
  resolveToast,
  settleIncoming,
  settleLeftover,
} from "@/components/workspace-detail/move-resolve";
import type { IncomingConversationTransfer } from "@/terminal/transport/conversation-codec";
import {
  CLAUDE,
  CONVERSATION_ID,
  SESSION_ID,
  SOURCE,
  SOURCE_ID,
  TARGET,
  TARGET_ID,
  TRANSFER_ID,
  type World,
  world,
} from "./move-fakes";

/**
 * A move that did not finish, resolved from any device: the hosts' own
 * records decide, a host that cannot be reached decides nothing, and one
 * empty listing is never taken for "nothing is moving".
 */

const hosts = new Map([
  [SOURCE_ID, SOURCE],
  [TARGET_ID, TARGET],
]);

/** A move that stopped mid-carry and was left (its mover went away). */
async function abandoned(w: World, options: { committed?: boolean } = {}) {
  const preview = await previewMove(
    { session: w.server.session, agent: CLAUDE, from: SOURCE, to: TARGET, cwd: "~/code/spawn" },
    w.deps,
  );
  if (preview.kind !== "ready") throw new Error("not ready");
  const move = new MoveRun(preview.plan, "default", w.deps);
  if (options.committed) {
    w.server.knobs.commitErrors = Array.from({ length: 3 }, () => ({
      status: 409,
      detail: "target_offline",
    }));
  } else {
    w.source.readFailsAfter = [1, 0, 0, 0];
  }
  await move.start();
  w.log.length = 0;
  w.queued.length = 0;
  return move;
}

describe("resolveMove", () => {
  it("a target that committed finishes the move: retire committed, window rebound, resume queued", async () => {
    const w = world();
    // The mover's retire commit never reached the source.
    w.source.conversationRetireCommit = async () => {
      throw new Error("source went quiet");
    };
    await abandoned(w, { committed: true });
    w.source.conversationRetireCommit = Object.getPrototypeOf(w.source).conversationRetireCommit;
    expect(w.server.session.status).toBe("moving");
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome).toMatchObject({ kind: "finished", message: "Moved to mac." });
    expect(w.log).toEqual([
      "source:conv.transfers",
      "target:conv.import.status",
      "source:conv.retire.commit",
      "source:conv.probe",
      "target:conv.probe",
      "server:commit",
    ]);
    expect(w.server.session.host_id).toBe(TARGET_ID);
    expect(w.queued[0]?.line).toBe(`claude --resume ${CONVERSATION_ID} --permission-mode default`);
    expect(w.queued[0]?.arrival).toMatchObject({
      agent: "Claude Code",
      note: { delivery: "typed_no_enter" },
    });
    // Typable once the commit answered, by this device.
    expect(w.typable(SESSION_ID, TARGET_ID)).toBe(w.queued[0]?.line);
    // The source folder, home-relative, is where it starts on the target.
    expect(w.server.commits.at(-1)?.cwd).toBe("~/code/spawn");
  });

  it("a commit another device made first leaves nothing to type here", async () => {
    const w = world();
    w.source.conversationRetireCommit = async () => {
      throw new Error("source went quiet");
    };
    await abandoned(w, { committed: true });
    w.source.conversationRetireCommit = Object.getPrototypeOf(w.source).conversationRetireCommit;
    w.server.knobs.commitErrors = [{ status: 409, detail: "move_conflict" }];
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome).toEqual({ kind: "settled", message: copy.MOVE_CONFLICT_SETTLED });
    expect(w.queued).toHaveLength(1);
    expect(w.launches.size).toBe(0);
  });

  it("a target still receiving is cancelled there first, then the files go back and the window restarts", async () => {
    const w = world();
    await abandoned(w);
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome).toMatchObject({
      kind: "restored",
      message: "Back on dream — nothing was lost.",
    });
    expect(w.log).toEqual([
      "source:conv.transfers",
      "target:conv.import.status",
      "target:conv.import.cancel",
      "source:conv.retire.abort",
      "server:abort",
      "source:conv.probe",
      "restart",
    ]);
    expect(w.source.outgoing.size).toBe(0);
    // Whoever puts it back leaves Claude Code running there: the conversation
    // that was moving, resumed in a mode said outright, for this device to type.
    expect(w.restartLines).toEqual([
      `claude --resume ${CONVERSATION_ID} --permission-mode default`,
    ]);
    expect(outcome).toMatchObject({ kind: "restored", restarted: true });
  });

  it("a put-back from another device resumes in the source's own mode, spelled for its shell", async () => {
    const w = world();
    await abandoned(w);
    w.source.probe = { ...w.source.probe, store: "~/.claude", loginShell: "/usr/bin/fish" };
    w.source.files.set("~/.claude/settings.json", '{"permissions":{"defaultMode":"plan"}}');
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome).toMatchObject({ kind: "restored", restarted: true });
    expect(w.restartLines).toEqual([`claude --resume ${CONVERSATION_ID} --permission-mode plan`]);
  });

  it("a cancel the target does not answer as cancelled leaves the source's files where they are", async () => {
    const w = world();
    await abandoned(w);
    w.target.cancelAnswer = "receiving";
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome.kind).toBe("unreachable");
    expect(w.log).not.toContain("source:conv.retire.abort");
    expect(w.source.outgoing.size).toBe(1);
    expect(w.server.session.status).toBe("moving");
  });

  it("no record, read twice, and the window runs on the source: only the server's mark comes off", async () => {
    const w = world();
    await w.server.begin(w.server.session.id, SOURCE_ID);
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome.kind).toBe("restored");
    expect(w.log).toEqual([
      "server:begin",
      "source:conv.transfers",
      "source:conv.transfers",
      "source:conv.inspect",
      "server:abort",
    ]);
    expect(w.server.session.status).toBe("running");
    expect(w.restarts).toEqual([]);
    expect(outcome).toMatchObject({ kind: "restored", restarted: false });
  });

  it("no record, the window stopped, its conversation still in place: put back and restarted", async () => {
    const w = world({ sessionStatus: "killed" });
    await w.server.begin(w.server.session.id, SOURCE_ID);
    w.source.inspection = null;
    w.source.probe = {
      ...w.source.probe,
      duplicates: [{ folder: "-home-me-code-spawn", path: "x", size: 1, live: false }],
    };
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome.kind).toBe("restored");
    expect(w.log).toContain("server:abort");
    expect(w.server.session.status).toBe("killed");
    expect(w.restarts).toHaveLength(1);
    // No transfer names the conversation: the window's own record does.
    expect(w.restartLines).toEqual([
      `claude --resume ${CONVERSATION_ID} --permission-mode default`,
    ]);
  });

  it("no record, the window stopped and its conversation gone from the source: nothing decided, Give up offered", async () => {
    const w = world();
    await w.server.begin(w.server.session.id, SOURCE_ID);
    w.source.inspection = null;
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome).toEqual({
      kind: "unreachable",
      message: copy.moveResolveUnconfirmed("dream"),
      giveUp: copy.moveGiveUpBody("dream", null),
    });
    expect(w.log).not.toContain("server:abort");
    expect(w.server.session.status).toBe("moving");
  });

  /**
   * Another device's Resolve while this one's retire is inside its fence:
   * the window is stopped and the record not yet written. The resolver's
   * wait before its second read is when the mover writes it.
   */
  function racing(w: World) {
    let writeRecord!: () => void;
    const recorded = new Promise<void>((resolve) => {
      writeRecord = resolve;
    });
    w.source.beforeRecord = () => recorded;
    const resolving: { promise: ReturnType<typeof resolveMove> | null } = { promise: null };
    w.source.onStopped = () => {
      w.server.exited();
      resolving.promise = resolveMove(
        { session: w.server.session, agent: CLAUDE, hosts },
        {
          ...w.deps,
          sleep: async () => {
            writeRecord();
            await new Promise((resolve) => setTimeout(resolve, 0));
          },
        },
      );
    };
    return resolving;
  }

  it("racing a mover in its fence that is still carrying: the re-read finds it, put back in order, both devices agree", async () => {
    const w = world();
    const preview = await previewMove(
      { session: w.server.session, agent: CLAUDE, from: SOURCE, to: TARGET, cwd: "~/code/spawn" },
      w.deps,
    );
    if (preview.kind !== "ready") throw new Error("not ready");
    const resolving = racing(w);
    // The mover is slow to reach the target: it begins its import only once
    // the resolver has finished.
    const importing = w.target.conversationImport.bind(w.target);
    w.target.conversationImport = async (request) => {
      await resolving.promise;
      return importing(request);
    };
    const move = new MoveRun(preview.plan, "default", w.deps);
    await move.start();
    const outcome = await (resolving.promise as unknown as ReturnType<typeof resolveMove>);
    const reads = w.log.filter((entry) => entry === "source:conv.transfers");
    expect(reads.length).toBeGreaterThanOrEqual(2);
    // Never a bare server abort before the target answered "cancelled".
    expect(w.log.indexOf("target:conv.import.cancel")).toBeGreaterThan(-1);
    expect(w.log.indexOf("target:conv.import.cancel")).toBeLessThan(w.log.indexOf("server:abort"));
    expect(outcome.kind).toBe("restored");
    // One truth on both devices: the conversation is back on the source and
    // the target holds nothing; the mover says another device settled it.
    expect(w.target.landed()).toBe(false);
    expect(w.source.outgoing.size).toBe(0);
    expect(w.server.session.host_id).toBe(SOURCE_ID);
    expect(w.server.session.status).not.toBe("moving");
    expect(move.phase).toMatchObject({
      step: "failed",
      failure: { message: copy.MOVE_CONFLICT_SETTLED },
    });
    expect(w.launches.size).toBe(0);
  });

  it("racing a mover in its fence that finishes while the resolver waits: the resolver leaves it, the move lands", async () => {
    const w = world();
    const preview = await previewMove(
      { session: w.server.session, agent: CLAUDE, from: SOURCE, to: TARGET, cwd: "~/code/spawn" },
      w.deps,
    );
    if (preview.kind !== "ready") throw new Error("not ready");
    const resolving = racing(w);
    const move = new MoveRun(preview.plan, "default", w.deps);
    await move.start();
    const outcome = await (resolving.promise as unknown as ReturnType<typeof resolveMove>);
    // Retired and committed before the second read: no record, the window
    // stopped, the conversation gone from the source — so the resolver
    // decides nothing, and says where it may be.
    expect(outcome).toMatchObject({
      kind: "unreachable",
      message: copy.moveResolveUnconfirmed("dream"),
    });
    expect(w.log).not.toContain("server:abort");
    expect(move.phase).toMatchObject({ step: "done", outcome: "launched" });
    expect(w.server.session.host_id).toBe(TARGET_ID);
    expect(w.target.landed()).toBe(true);
  });

  it("a target that cannot be reached leaves everything as it is, and offers Give up", async () => {
    const w = world();
    await abandoned(w);
    w.unreachable.add(TARGET_ID);
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome).toEqual({
      kind: "unreachable",
      message:
        "mac can't be reached, so SPAWN D can't tell whether the conversation arrived. Try again once it's online.",
      giveUp: copy.moveGiveUpBody("dream", "mac"),
    });
    expect(w.log).toEqual(["source:conv.transfers"]);
    expect(w.source.outgoing.size).toBe(1);
    expect(w.server.session.status).toBe("moving");
  });

  it("a target no longer in the account is a host that cannot answer, with Give up", async () => {
    const w = world();
    await abandoned(w);
    const outcome = await resolveMove(
      { session: w.server.session, agent: CLAUDE, hosts: new Map([[SOURCE_ID, SOURCE]]) },
      w.deps,
    );
    expect(outcome).toMatchObject({
      kind: "unreachable",
      message:
        "The host it was going to can't be reached, so SPAWN D can't tell whether the conversation arrived. Try again once it's online.",
      giveUp: copy.moveGiveUpBody("dream", null),
    });
  });

  it("a source that cannot be reached decides nothing, and offers Give up", async () => {
    const w = world();
    await abandoned(w);
    w.unreachable.add(SOURCE_ID);
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome).toEqual({
      kind: "unreachable",
      message: "dream is offline, so this move can't be finished or put back until it's back.",
      giveUp:
        "The window stops on dream. Its conversation stays where it is now — set aside on dream, or already on the host it was going to — until you resolve the move from dream's page.",
    });
    expect(w.log).toEqual([]);
  });

  it("files the source cannot put back are said to need a person", async () => {
    const w = world();
    await abandoned(w);
    w.source.retireAbortError = "already_exists";
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome).toMatchObject({ kind: "stranded", message: copy.moveConflicts("dream") });
  });

  it("another device resolved it first", async () => {
    const w = world();
    await abandoned(w);
    w.server.knobs.abortError = { status: 409, detail: "move_conflict" };
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(outcome).toEqual({ kind: "settled", message: copy.MOVE_CONFLICT_SETTLED });
  });
});

describe("giveUpMove", () => {
  it("ends the server's move alone: neither host is asked, what is set aside stays", async () => {
    const w = world();
    await abandoned(w);
    w.unreachable.add(SOURCE_ID);
    const outcome = await giveUpMove(w.server.session, "dream", w.deps);
    expect(outcome).toMatchObject({
      kind: "given_up",
      message:
        "The move was given up and the window is back on dream. Resolve its conversation from dream's page once both hosts can be reached.",
    });
    expect(w.log).toEqual(["server:abort"]);
    expect(w.server.session.status).toBe("killed");
    expect(w.source.outgoing.size).toBe(1);
    expect(w.restarts).toEqual([]);
  });

  it("a move settled meanwhile is said so", async () => {
    const w = world();
    await abandoned(w);
    w.server.knobs.abortError = { status: 409, detail: "move_conflict" };
    expect(await giveUpMove(w.server.session, "dream", w.deps)).toEqual({
      kind: "settled",
      message: copy.MOVE_CONFLICT_SETTLED,
    });
  });
});

describe("settleLeftover", () => {
  it("commits the retire of a transfer the target committed", async () => {
    const w = world();
    await abandoned(w);
    const transfer = (await w.source.conversationTransfers()).outgoing[0];
    if (!transfer) throw new Error("no transfer");
    w.target.tombstones.set(TRANSFER_ID, "committed");
    w.log.length = 0;
    const outcome = await settleLeftover(
      transfer,
      { channel: w.source, release: () => undefined },
      hosts,
      w.deps,
      "dream",
    );
    expect(outcome.kind).toBe("settled");
    expect(w.log).toEqual(["target:conv.import.status", "source:conv.retire.commit"]);
  });
});

describe("settleIncoming", () => {
  const staged = (transferId: string): IncomingConversationTransfer => ({
    transferId,
    conversationId: CONVERSATION_ID,
    fromHostId: SOURCE_ID,
    state: "receiving",
    received: 0,
    nextSequence: 0,
    length: 100,
    createdAt: 1,
  });

  it("staging its source no longer lists is let go here", async () => {
    const w = world();
    const outcome = await settleIncoming(staged("lost"), w.target, hosts, w.deps);
    expect(outcome.kind).toBe("restored");
    expect(w.log).toEqual(["source:conv.transfers", "target:conv.import.cancel"]);
  });

  it("a listing the source cut short decides nothing: a live import is never cancelled", async () => {
    const w = world();
    w.source.conversationTransfers = async () => ({ outgoing: [], incoming: [], truncated: true });
    const outcome = await settleIncoming(staged("maybe"), w.target, hosts, w.deps);
    expect(outcome.kind).toBe("failed");
    expect(w.log).not.toContain("target:conv.import.cancel");
  });

  it("a source that cannot answer decides nothing", async () => {
    const w = world();
    w.unreachable.add(SOURCE_ID);
    const outcome = await settleIncoming(staged("maybe"), w.target, hosts, w.deps);
    expect(outcome).toMatchObject({ kind: "unreachable", giveUp: null });
    expect(w.log).toEqual([]);
  });
});

describe("guessTargetCwd", () => {
  it("names the source folder from home", () => {
    expect(guessTargetCwd("/home/me/code/spawn", "/home/me")).toBe("~/code/spawn");
    expect(guessTargetCwd("/home/me", "/home/me")).toBe("~");
    expect(guessTargetCwd("/srv/app", "/home/me")).toBe("/srv/app");
    expect(guessTargetCwd("/home/meow/x", "/home/me")).toBe("/home/meow/x");
  });
});

describe("what a settled Resolve says", () => {
  const names = (id: string) => (id === SOURCE_ID ? "dream" : id === TARGET_ID ? "mac" : "?");

  it("a put-back on a host's page says the window's agent resumes when it is opened, and offers it", async () => {
    const w = world();
    await abandoned(w);
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(resolveToast(outcome, names, true)).toEqual({
      message: "Back on dream — nothing was lost.",
      detail: "Claude Code resumes on dream when you open the window.",
      persistent: true,
      openWindow: expect.objectContaining({ id: SESSION_ID }),
    });
    // A screen showing the window opens it itself: only the outcome.
    expect(resolveToast(outcome, names, false)).toEqual({
      message: "Back on dream — nothing was lost.",
      detail: null,
      persistent: false,
      openWindow: null,
    });
  });

  it("a finished move offers the window on its new host", async () => {
    const w = world();
    w.source.conversationRetireCommit = async () => {
      throw new Error("source went quiet");
    };
    await abandoned(w, { committed: true });
    w.source.conversationRetireCommit = Object.getPrototypeOf(w.source).conversationRetireCommit;
    const outcome = await resolveMove({ session: w.server.session, agent: CLAUDE, hosts }, w.deps);
    expect(resolveToast(outcome, names, true)).toMatchObject({
      message: "Moved to mac.",
      detail: "Claude Code resumes on mac when you open the window.",
      openWindow: expect.objectContaining({ id: SESSION_ID }),
    });
  });

  it("nothing restarted offers nothing, and what still asks for something stays on the sheet", () => {
    expect(
      resolveToast(
        {
          kind: "restored",
          session: null,
          message: "Back on dream — nothing was lost.",
          restarted: false,
        },
        names,
        true,
      ),
    ).toMatchObject({ openWindow: null, detail: null });
    expect(
      resolveToast({ kind: "unreachable", message: "x", giveUp: null }, names, true),
    ).toBeNull();
    expect(resolveToast({ kind: "failed", message: "x" }, names, true)).toBeNull();
    expect(
      resolveToast({ kind: "settled", message: copy.MOVE_CONFLICT_SETTLED }, names, true),
    ).toEqual({
      message: copy.MOVE_CONFLICT_SETTLED,
      detail: null,
      persistent: false,
      openWindow: null,
    });
  });
});
