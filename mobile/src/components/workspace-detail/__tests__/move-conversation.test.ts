import {
  type MovePhase,
  type MovePlan,
  MoveRun,
  previewMove,
  readFolderCommit,
} from "@/components/workspace-detail/move-conversation";
import * as copy from "@/components/workspace-detail/move-copy";
import { ApiError } from "@/data/api/client";
import type { PermissionMode } from "@/data/selectors/move-facts";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-error";
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
 * The move orchestrator against a daemon pair and a server in memory: the
 * failure matrix of move.md and the client contract, end to end.
 */

async function ready(w: World, overrides: Partial<{ cwd: string }> = {}) {
  const preview = await previewMove(
    {
      session: w.server.session,
      agent: CLAUDE,
      from: SOURCE,
      to: TARGET,
      cwd: overrides.cwd ?? "~/code/spawn",
    },
    w.deps,
  );
  if (preview.kind !== "ready") throw new Error(`Expected a ready preview, got ${preview.kind}`);
  return preview;
}

function run(w: World, plan: MovePlan, mode: PermissionMode = "default") {
  const move = new MoveRun(plan, mode, w.deps);
  const phases: MovePhase[] = [];
  move.subscribe((phase) => phases.push(phase));
  return { move, phases };
}

function failureOf(move: MoveRun) {
  if (move.phase.step !== "failed") throw new Error(`Expected a failure, got ${move.phase.step}`);
  return move.phase.failure;
}

/** Every word the move showed, so no code or slug can hide in one. */
function shown(phases: readonly MovePhase[]): string {
  return phases
    .map((phase) =>
      phase.step === "failed"
        ? `${phase.failure.message} ${phase.failure.detail ?? ""}`
        : phase.step === "restored"
          ? phase.message
          : "",
    )
    .join(" ");
}

describe("preview: what the dialog says before anything changes", () => {
  it("a working Claude window: title, body with the size, state line, both on the same commit", async () => {
    const w = world();
    for (const daemon of [w.source, w.target]) {
      daemon.files.set("/home/me/code/spawn/.git/HEAD", "ref: refs/heads/main\n");
      daemon.files.set("/home/me/code/spawn/.git/refs/heads/main", `${"a".repeat(40)}\n`);
      daemon.files.set("~/code/spawn/.git/HEAD", "ref: refs/heads/main\n");
      daemon.files.set("~/code/spawn/.git/refs/heads/main", `${"a".repeat(40)}\n`);
    }
    const preview = await ready(w);
    expect(preview.dialog).toEqual({
      title: "Move Claude Code to mac?",
      body: copy.moveBody({ from: "dream", to: "mac", cwd: "~/code/spawn", bytes: 3 * 8192 + 100 }),
      stateLine: copy.moveStateLine("running", "mac"),
      info: ["Both are on main at aaaaaaa."],
      warnings: [],
      defaultMode: "default",
    });
    // The size in the files' own units, as the browser writes it.
    expect(preview.dialog.body).toContain("(24 KB)");
    // Nothing changed: only reads went out.
    expect(
      w.log.filter((entry) => !entry.endsWith("conv.inspect") && !entry.endsWith("conv.probe")),
    ).toEqual([]);
  });

  it("names the agent Claude Code everywhere, never its definition's slug", async () => {
    const w = world();
    w.target.probe = { ...w.target.probe, cliVersion: "2.1.250" };
    const preview = await ready(w);
    const words = [
      preview.dialog.title,
      preview.dialog.body,
      preview.dialog.stateLine,
      ...preview.dialog.warnings,
    ].join(" ");
    expect(CLAUDE.name).toBe("claude-code");
    expect(words).toContain("Claude Code");
    expect(words).not.toContain("claude-code");
  });

  it("warns of different heads, a slow relayed carry and an older Claude; notes a copy set aside", async () => {
    const w = world();
    w.target.probe = {
      ...w.target.probe,
      cliVersion: "2.1.250",
      duplicates: [{ folder: "-Users-me-code-spawn", path: "x", size: 1, live: false }],
    };
    w.source.files.set("/home/me/code/spawn/.git/HEAD", "ref: refs/heads/feat-x\n");
    w.target.files.set("~/code/spawn/.git/HEAD", `${"b".repeat(40)}\n`);
    w.source.transcripts = {
      ...(w.source.transcripts as NonNullable<typeof w.source.transcripts>),
      transcripts: [
        {
          path: "x",
          name: "x.jsonl",
          size: 40_000_000,
          modified_at: null,
          role: "conversation",
          conversation_id: CONVERSATION_ID,
        },
      ],
    };
    w.target.connectionInfo = { kind: "relay", rttMs: 55 };
    const preview = await ready(w);
    expect(preview.dialog.warnings).toEqual([
      "dream is on feat-x; mac is on bbbbbbb.",
      copy.moveEstimate("45 seconds"),
      "Claude Code on mac (2.1.250) is older than on dream (2.1.289).",
    ]);
    expect(preview.dialog.info).toEqual([
      "An older copy of this conversation on mac will be set aside.",
    ]);
    expect(preview.dialog.body).toContain("(38 MB)");
  });

  it("a repository here and none there is said; Claude Code not found there is a warning", async () => {
    const w = world();
    w.target.probe = { ...w.target.probe, cliPath: null, cliVersion: null };
    w.source.files.set("/home/me/code/spawn/.git/HEAD", `${"c".repeat(40)}\n`);
    const preview = await ready(w);
    expect(preview.dialog.warnings).toEqual([
      "~/code/spawn on mac isn't a git repository, so SPAWN D can't compare it with the one here.",
      "SPAWN D couldn't find Claude Code on mac.",
    ]);
  });

  it("Claude Code found there with no version to read is not missing, and is not compared", async () => {
    // The source's Claude is newer than anything: only a version could be older.
    const newerSource = (cliVersion: string | null) => {
      const w = world();
      w.source.inspection = {
        ...(w.source.inspection as NonNullable<typeof w.source.inspection>),
        cli_version: "9.9.999",
      };
      w.target.probe = { ...w.target.probe, cliPath: "/opt/spawn/claude", cliVersion };
      return w;
    };
    const preview = await ready(newerSource(null));
    expect(preview.dialog.warnings).toEqual([]);
    const words = [preview.dialog.body, preview.dialog.stateLine, ...preview.dialog.info].join(" ");
    expect(words).not.toContain("/opt/spawn/claude");

    // Found with a version: compared as before.
    expect((await ready(newerSource("2.1.289"))).dialog.warnings).toEqual([
      "Claude Code on mac (2.1.289) is older than on dream (9.9.999).",
    ]);
  });

  it("an idle window's note waits for the next message; a yolo window keeps bypassing", async () => {
    const w = world();
    w.source.inspection = {
      ...(w.source.inspection as NonNullable<typeof w.source.inspection>),
      state: "idle",
    };
    const preview = await previewMove(
      {
        session: w.server.session,
        agent: { ...CLAUDE, yolo: true, yolo_args: "--dangerously-skip-permissions" },
        from: SOURCE,
        to: TARGET,
        cwd: "~/code/spawn",
      },
      w.deps,
    );
    expect(preview.kind === "ready" && preview.dialog.stateLine).toBe(
      copy.moveStateLine("idle", "mac"),
    );
    expect(preview.kind === "ready" && preview.dialog.defaultMode).toBe("bypassPermissions");
  });

  it("a yolo window whose agent cannot skip its prompts starts in the target's own default", async () => {
    const w = world();
    w.target.files.set(
      "~/.claude/settings.json",
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
    );
    const preview = await previewMove(
      {
        session: w.server.session,
        agent: { ...CLAUDE, yolo: true, yolo_args: null, yolo_env: {} },
        from: SOURCE,
        to: TARGET,
        cwd: "~/code/spawn",
      },
      w.deps,
    );
    expect(preview.kind === "ready" && preview.dialog.defaultMode).toBe("acceptEdits");
  });

  it("starts in the target's own default mode", async () => {
    const w = world();
    w.target.files.set(
      "~/.claude/settings.json",
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
    );
    expect((await ready(w)).dialog.defaultMode).toBe("acceptEdits");
  });

  it.each([
    [
      "the source is offline",
      (w: World) => w.unreachable.add(SOURCE_ID),
      copy.moveSourceOffline("dream", "mac"),
      "on_target",
    ],
    [
      "the target is not connected to this device",
      (w: World) => w.unreachable.add(TARGET_ID),
      "mac isn't connected to this device right now, so the conversation can't come along.",
      "instead",
    ],
    [
      "the target cannot be checked",
      (w: World) => {
        w.target.conversationProbe = async () => {
          throw new Error("no answer");
        };
      },
      "SPAWN D couldn't check mac. Try again in a moment.",
      "instead",
    ],
    [
      "something outside the window holds the conversation",
      (w: World) => {
        w.source.inspection = {
          ...(w.source.inspection as NonNullable<typeof w.source.inspection>),
          live_elsewhere: true,
        };
      },
      "This conversation is also open in another window or in the background on dream. Close it there first.",
      "instead",
    ],
    [
      "a Claude on the target holds it",
      (w: World) => {
        w.target.probe = { ...w.target.probe, live: true };
      },
      "This conversation is open in Claude Code on mac. Close it there first.",
      "instead",
    ],
    [
      "Claude Code was never set up on the target",
      (w: World) => {
        w.target.probe = { ...w.target.probe, storeReady: false, storeProblem: "store_missing" };
      },
      copy.moveStoreNotReady("mac"),
      "instead",
    ],
    [
      "the folder does not exist on the target",
      (w: World) => {
        w.target.probe = { ...w.target.probe, folderExists: false };
      },
      "~/code/spawn doesn't exist on mac. Create it there, or start fresh — a new conversation creates the folder.",
      "instead",
    ],
    [
      "no conversation can be named",
      (w: World) => {
        w.source.inspection = null;
        w.server.session = { ...w.server.session, agent_session_id: null };
      },
      copy.MOVE_NO_CONVERSATION,
      "instead",
    ],
    [
      "a file is over the 512 MB cap",
      (w: World) => {
        const report = w.source.transcripts as NonNullable<typeof w.source.transcripts>;
        w.source.transcripts = {
          ...report,
          transcripts: [
            {
              ...(report.transcripts[0] as (typeof report.transcripts)[number]),
              size: 600 * 1024 * 1024,
            },
          ],
        };
      },
      "This conversation has a file over 512 MB, more than a move can carry.",
      "instead",
    ],
  ])("blocks before anything stops when %s", async (_name, arrange, reason, startFresh) => {
    const w = world();
    arrange(w);
    const preview = await previewMove(
      { session: w.server.session, agent: CLAUDE, from: SOURCE, to: TARGET, cwd: "~/code/spawn" },
      w.deps,
    );
    expect(preview).toEqual({ kind: "blocked", reason, startFresh });
    expect(w.log.some((entry) => entry.startsWith("server:"))).toBe(false);
    // A missing folder is never made here: the move does not go.
    expect(w.log).not.toContain("target:fs.mkdir");
  });

  it("a conversation over 2 GB in all, no file over the cap, is the source's to refuse, as in the browser", async () => {
    const w = world();
    const report = w.source.transcripts as NonNullable<typeof w.source.transcripts>;
    const file = report.transcripts[0] as (typeof report.transcripts)[number];
    w.source.transcripts = {
      ...report,
      transcripts: Array.from({ length: 5 }, (_, index) => ({
        ...file,
        name: `${index}.jsonl`,
        size: 500 * 1024 * 1024,
      })),
    };
    const preview = await previewMove(
      { session: w.server.session, agent: CLAUDE, from: SOURCE, to: TARGET, cwd: "~/code/spawn" },
      w.deps,
    );
    expect(preview.kind).toBe("ready");
  });

  it("hosts without the carrier get the fresh move, said honestly, naming every one", async () => {
    const w = world();
    w.target.capabilities.delete("conv.v2");
    w.source.capabilities.delete("conv.v2");
    const preview = await previewMove(
      { session: w.server.session, agent: CLAUDE, from: SOURCE, to: TARGET, cwd: "~/code/spawn" },
      w.deps,
    );
    expect(preview).toEqual({
      kind: "fresh",
      reason:
        "SPAWN D on dream and mac can't carry conversations yet, so Claude Code starts a new one on mac.",
    });
  });

  it("reads a linked worktree's commit through its gitdir and the common dir's packed refs", async () => {
    const w = world();
    w.source.files.set("/repo/wt/.git", "gitdir: ../main/.git/worktrees/wt\n");
    w.source.files.set("/repo/main/.git/worktrees/wt/HEAD", "ref: refs/heads/topic\n");
    w.source.files.set("/repo/main/.git/worktrees/wt/commondir", "../..\n");
    w.source.files.set(
      "/repo/main/.git/packed-refs",
      `# pack-refs with: peeled\n${"b".repeat(40)} refs/heads/topic\n`,
    );
    await expect(readFolderCommit(w.source, "/repo/wt")).resolves.toEqual({
      branch: "topic",
      commit: "b".repeat(40),
    });
  });
});

describe("the move, forward", () => {
  it("carries a working conversation: begin, retire, pump, commit the import, settle both ends", async () => {
    const w = world();
    const { move, phases } = run(w, (await ready(w)).plan);
    await move.start();
    expect(move.phase).toMatchObject({ step: "done", outcome: "launched", state: "running" });
    expect(w.target.landed()).toBe(true);
    expect(w.source.outgoing.size).toBe(0);
    expect(w.log).toEqual([
      "source:conv.inspect",
      "target:conv.probe",
      // Sampled again as the person confirms.
      "source:conv.inspect",
      "server:begin",
      "source:conv.export@0",
      "target:conv.import.begin",
      "target:stream.end",
      "source:conv.retire.commit",
      "server:commit",
    ]);
    expect(phases.map((phase) => phase.step)).toEqual(
      expect.arrayContaining(["beginning", "stopping", "copying", "starting", "done"]),
    );
    const copying = phases.filter((phase) => phase.step === "copying");
    expect(copying.at(-1)).toEqual({
      step: "copying",
      sent: 3 * 8192 + 100,
      total: 3 * 8192 + 100,
    });
    expect(w.server.commits).toEqual([
      {
        host_id: TARGET_ID,
        cwd: "~/code/spawn",
        expected_host_id: SOURCE_ID,
        agent_id: "agent-1",
        agent_session_id: CONVERSATION_ID,
        carried: true,
      },
    ]);
    // The resume line names the mode and carries the note as its first prompt.
    const [queued] = w.queued;
    expect(queued?.hostId).toBe(TARGET_ID);
    expect(queued?.line).toMatch(
      new RegExp(
        `^claude --resume ${CONVERSATION_ID} --permission-mode default '\\[SPAWN D\\] This conversation just moved from dream \\(Linux\\) to mac \\(macOS\\)`,
      ),
    );
    expect(queued?.arrival.note?.delivery).toBe("positional");
    expect(queued?.arrival.agent).toBe("Claude Code");
    // Typable only now the commit has answered.
    expect(w.typable(SESSION_ID, TARGET_ID)).toBe(queued?.line);
    expect(w.restarts).toEqual([]);
  });

  it("the resume line is provisional until the commit answers", async () => {
    const w = world();
    const { move } = run(w, (await ready(w)).plan);
    const typableDuringCommit: Array<string | null> = [];
    const commit = w.server.commit.bind(w.server);
    w.server.commit = async (id, body) => {
      typableDuringCommit.push(w.typable(SESSION_ID, TARGET_ID));
      return commit(id, body);
    };
    await move.start();
    expect(typableDuringCommit).toEqual([null]);
    expect(w.typable(SESSION_ID, TARGET_ID)).not.toBeNull();
  });

  it("an idle conversation resumes plainly and its note waits, typed without Enter", async () => {
    const w = world();
    w.source.inspection = {
      ...(w.source.inspection as NonNullable<typeof w.source.inspection>),
      state: "idle",
    };
    const { move } = run(w, (await ready(w)).plan, "plan");
    await move.start();
    const [queued] = w.queued;
    expect(queued?.line).toBe(`claude --resume ${CONVERSATION_ID} --permission-mode plan`);
    expect(queued?.arrival.note).toEqual({
      text: expect.stringMatching(/^\[SPAWN D: moved from dream \(Linux\) to mac \(macOS\)/),
      delivery: "typed_no_enter",
    });
  });

  it("the note follows what Claude was doing when the person confirmed, not when the dialog opened", async () => {
    const w = world();
    const plan = (await ready(w)).plan;
    w.source.inspection = {
      ...(w.source.inspection as NonNullable<typeof w.source.inspection>),
      state: "idle",
    };
    const { move } = run(w, plan);
    await move.start();
    expect(move.phase).toMatchObject({ step: "done", state: "idle" });
    expect(w.queued[0]?.arrival.note?.delivery).toBe("typed_no_enter");
  });

  it("a shell that cannot carry a note on its line gets the note typed after the prompt", async () => {
    const w = world();
    w.target.probe = { ...w.target.probe, loginShell: "nu" };
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(w.queued[0]?.line).toBe(`claude --resume ${CONVERSATION_ID} --permission-mode default`);
    expect(w.queued[0]?.arrival.note?.delivery).toBe("typed");
  });

  it("moves a stopped window: its recorded conversation, idle, nothing to stop", async () => {
    const w = world({ sessionStatus: "killed" });
    w.source.inspection = null;
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(move.phase).toMatchObject({ step: "done", state: "idle" });
    expect(w.target.landed()).toBe(true);
  });

  it("a workspace archived meanwhile: committed, nothing typed", async () => {
    const w = world();
    w.server.knobs.archived = true;
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(move.phase).toMatchObject({ step: "done", outcome: "archived" });
    expect(w.launches.size).toBe(0);
  });
});

describe("the move, when the server refuses it", () => {
  it.each([
    ["source_offline", copy.moveSourceOffline("dream", "mac"), ["start_fresh", "close"]],
    ["move_in_progress", copy.MOVE_IN_PROGRESS, ["close"]],
    ["move_conflict", copy.MOVE_CONFLICT_RESTART, ["close"]],
    ["workspace_archived", copy.MOVE_WORKSPACE_ARCHIVED, ["close"]],
    ["something_new", copy.MOVE_BEGIN_FAILED, ["retry", "close"]],
  ])("begin answers %s: nothing changed anywhere", async (detail, message, actions) => {
    const w = world();
    w.server.knobs.beginError = { status: 409, detail };
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(failureOf(move)).toEqual({ message, detail: null, actions, held: false });
    expect(w.log.some((entry) => entry.includes("conv.export"))).toBe(false);
  });

  it("a window deleted before the begin", async () => {
    const w = world();
    w.server.knobs.beginError = { status: 404, detail: "session not found" };
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(failureOf(move).message).toBe("This window no longer exists.");
  });
});

describe("the move, when the source refuses to retire", () => {
  it("live elsewhere: the server move is aborted, Claude still runs, nothing restarted", async () => {
    const w = world();
    w.source.exportRefusals = ["conversation_live_elsewhere"];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    const failure = failureOf(move);
    expect(failure.message).toBe(
      "This conversation is also open in another window or in the background on dream, so nothing was moved. Close it there first.",
    );
    expect(failure.detail).toContain("Nothing was lost — Claude Code is still running on dream.");
    expect(failure.held).toBe(false);
    expect(w.server.session.status).toBe("running");
    expect(w.restarts).toEqual([]);
    expect(w.log).not.toContain("target:conv.import.cancel");
  });

  it.each([
    [
      "window_restarted",
      "This window was restarted on dream while it was moving, so the move was cancelled.",
    ],
    ["agent_still_running", "dream didn't confirm that Claude Code stopped, so nothing was moved."],
    [
      "conversation_changed",
      "This window switched to another conversation on dream, so nothing was moved. Try again.",
    ],
    [
      "window_unavailable",
      "dream hasn't picked this window up yet, so nothing was moved. Try again in a moment.",
    ],
    [
      "transfer_unresolved",
      "Another move of this conversation hasn't finished. Resolve it on dream's page first.",
    ],
    ["too_large", "This conversation is more than a move can carry, so nothing was moved."],
    // A code this build does not know is said in words, never shown.
    ["store_exploded", "dream couldn't hand the conversation over, so nothing was moved."],
  ])("%s", async (code, message) => {
    const w = world();
    w.source.exportRefusals = [code];
    const { move, phases } = run(w, (await ready(w)).plan);
    await move.start();
    expect(failureOf(move).message).toBe(message);
    expect(w.server.session.status).toBe("running");
    expect(shown(phases)).not.toContain(code);
  });

  it("Try again after a refusal starts over under a new transfer", async () => {
    const w = world();
    const ids = [TRANSFER_ID, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
    (w.deps as { newTransferId: () => string }).newTransferId = () => ids.shift() ?? "";
    w.source.exportRefusals = ["window_unavailable"];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(failureOf(move).actions).toEqual(["retry", "close"]);
    await move.retry();
    expect(move.phase.step).toBe("done");
    expect(move.transferId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(w.target.landed("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(true);
  });

  it("a refusal that left the transfer stranded on the source is put back in order first", async () => {
    const w = world();
    // D2's fence could not restore what it moved: it records the transfer
    // stranded and answers with the original code.
    const realExport = w.source.conversationExport.bind(w.source);
    w.source.conversationExport = async (request) => {
      await realExport(request).catch(() => undefined);
      const held = w.source.outgoing.get(request.transferId);
      if (held) held.record = { ...held.record, state: "stranded" };
      throw new HostControlTransportError("window_restarted", "window_restarted");
    };
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    const at = (entry: string) => w.log.indexOf(entry);
    expect(at("target:conv.import.cancel")).toBeGreaterThan(-1);
    expect(at("target:conv.import.cancel")).toBeLessThan(at("source:conv.retire.abort"));
    expect(at("source:conv.retire.abort")).toBeLessThan(at("server:abort"));
    expect(w.source.outgoing.size).toBe(0);
    expect(failureOf(move).message).toBe(copy.moveRefusedRestarted("dream"));
  });

  it("a window stopped before the move is left stopped when the move is put back", async () => {
    const w = world({ sessionStatus: "killed" });
    w.target.importRefusals = ["insufficient_space"];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(failureOf(move).message).toBe(
      "mac doesn't have room for this conversation. Nothing was lost — it's still on dream.",
    );
    await move.putBack();
    expect(move.phase).toEqual({ step: "restored", message: "Back on dream — nothing was lost." });
    expect(w.server.session.status).toBe("killed");
    expect(w.restarts).toEqual([]);
  });
});

describe("the move, when a channel goes mid-carry", () => {
  it("the source's channel goes after two chunks: resumed from the target's next_sequence", async () => {
    const w = world();
    w.source.readFailsAfter = [2];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(move.phase.step).toBe("done");
    expect(w.source.exportCalls).toEqual([0, 2]);
    expect(w.log).toContain("target:conv.import.status");
    expect(w.target.landed()).toBe(true);
  });

  it("the target's channel goes after one chunk: the import is begun again where it ends", async () => {
    const w = world();
    w.target.writeFailsAfter = [1];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(move.phase.step).toBe("done");
    expect(w.source.exportCalls).toEqual([0, 1]);
  });

  it("an export that timed out after retiring is asked again with the same transfer", async () => {
    const w = world();
    w.source.exportTimeouts = 1;
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(move.phase.step).toBe("done");
    expect(w.source.exportCalls).toEqual([0, 0]);
    expect(w.source.outgoing.size).toBe(0);
  });

  it("bytes the target refused at the end are carried again from the start", async () => {
    const w = world();
    w.target.endRefusals = ["integrity_mismatch"];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(move.phase.step).toBe("done");
    expect(w.source.exportCalls).toEqual([0, 0]);
  });

  it("past its resumes the move is held: Try again carries on, nothing was stopped twice", async () => {
    const w = world();
    w.source.readFailsAfter = [1, 0, 0, 0];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(failureOf(move)).toEqual({
      message:
        "The conversation couldn't be copied to mac (connection lost). Nothing was lost — it's still on dream.",
      detail: null,
      actions: ["retry", "resume_source"],
      held: true,
    });
    expect(w.server.session.status).toBe("moving");
    await move.retry();
    expect(move.phase.step).toBe("done");
    expect(w.source.exportCalls[w.source.exportCalls.length - 1]).toBe(1);
  });

  it("Resume on the source puts it back in order: target cancelled, files back, server aborted, restarted", async () => {
    const w = world();
    w.source.readFailsAfter = [1, 0, 0, 0];
    const { move, phases } = run(w, (await ready(w)).plan);
    await move.start();
    w.log.length = 0;
    await move.putBack();
    expect(w.log).toEqual([
      "target:conv.import.cancel",
      "source:conv.retire.abort",
      "server:abort",
      // The source's shell, for the line that resumes it there.
      "source:conv.probe",
      "restart",
    ]);
    // Claude Code comes back in the conversation that was moving, in the mode
    // it ran in there: the line names none, so the record restores it.
    expect(w.restartLines).toEqual([`claude --resume ${CONVERSATION_ID}`]);
    expect(phases.at(-2)).toEqual({ step: "restoring" });
    expect(move.phase).toEqual({ step: "restored", message: "Back on dream — nothing was lost." });
    expect(w.source.outgoing.size).toBe(0);
    expect(w.server.session.status).toBe("killed");
  });

  it("a target that does not answer the cancel leaves everything where it is, and the move can be given up", async () => {
    const w = world();
    w.source.readFailsAfter = [1, 0, 0, 0];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    w.target.silent = true;
    w.log.length = 0;
    await move.putBack();
    expect(w.log).toEqual(["target:conv.import.cancel"]);
    expect(failureOf(move)).toEqual({
      message:
        "mac can't be reached, so the move can't be put back yet. The window stays “Moving” until you resolve it.",
      detail: null,
      actions: ["resume_source", "give_up", "close"],
      held: true,
    });
    expect(w.source.outgoing.size).toBe(1);
    expect(w.server.session.status).toBe("moving");
    // Given up: the server's move ends; neither host is asked anything.
    w.log.length = 0;
    await move.giveUp();
    expect(w.log).toEqual(["server:abort"]);
    expect(move.phase).toEqual({
      step: "restored",
      message:
        "The move was given up and the window is back on dream. Resolve its conversation from dream's page once both hosts can be reached.",
    });
    expect(w.server.session.status).not.toBe("moving");
    expect(w.source.outgoing.size).toBe(1);
  });

  it("a cancel the target does not answer as cancelled never lets the source put back", async () => {
    const w = world();
    w.source.readFailsAfter = [1, 0, 0, 0];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    w.target.cancelAnswer = "receiving";
    w.log.length = 0;
    await move.putBack();
    expect(w.log).toEqual(["target:conv.import.cancel"]);
    expect(failureOf(move)).toMatchObject({ actions: ["resume_source", "give_up", "close"] });
    expect(w.source.outgoing.size).toBe(1);
  });

  it("a target that had committed after all finishes the move instead of undoing it", async () => {
    const w = world();
    w.target.endRefusals = [
      "outcome_unknown",
      "outcome_unknown",
      "outcome_unknown",
      "outcome_unknown",
    ];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(move.phase.step).toBe("failed");
    // It committed while this device could not hear.
    w.target.tombstones.set(TRANSFER_ID, "committed");
    await move.putBack();
    expect(move.phase.step).toBe("done");
    expect(w.log).not.toContain("source:conv.retire.abort");
    expect(w.log).toContain("source:conv.retire.commit");
  });

  it("the source cannot put every file back: said, and the window is let go", async () => {
    const w = world();
    w.source.readFailsAfter = [1, 0, 0, 0];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    w.source.retireAbortError = "already_exists";
    await move.putBack();
    expect(failureOf(move)).toMatchObject({
      message:
        "Some of this conversation's files couldn't be put back on dream because files with those names are there. Sort them out by hand in Claude Code's projects folder on dream.",
      held: false,
    });
  });
});

describe("the move, when the person or the phone steps in", () => {
  it("Cancel mid-copy puts it back and says nothing was lost", async () => {
    const w = world();
    const plan = (await ready(w)).plan;
    const { move } = run(w, plan);
    let cancelled = false;
    move.subscribe((phase) => {
      if (phase.step === "copying" && !cancelled) {
        cancelled = true;
        move.cancel();
      }
    });
    await move.start();
    expect(move.phase).toEqual({ step: "restored", message: copy.moveCancelled("dream") });
    expect(w.log).toContain("target:conv.import.cancel");
    expect(w.log.indexOf("target:conv.import.cancel")).toBeLessThan(
      w.log.indexOf("source:conv.retire.abort"),
    );
    expect(w.target.landed()).toBe(false);
  });

  it("Cancel while the server's begin is in flight ends the move it began", async () => {
    const w = world();
    const plan = (await ready(w)).plan;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const begin = w.server.begin.bind(w.server);
    w.server.begin = async (id, expected) => {
      await gate;
      return begin(id, expected);
    };
    const { move } = run(w, plan);
    const done = move.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    move.cancel();
    release();
    await done;
    expect(move.phase).toEqual({ step: "restored", message: copy.moveCancelled("dream") });
    expect(w.server.session.status).not.toBe("moving");
    expect(w.log).toContain("server:abort");
    expect(w.log.some((entry) => entry.includes("conv.export"))).toBe(false);
  });

  it("the background deadline stops it where it is; Try again finishes it", async () => {
    const w = world();
    const { move } = run(w, (await ready(w)).plan);
    let interrupted = false;
    move.subscribe((phase) => {
      if (phase.step === "copying" && !interrupted) {
        interrupted = true;
        move.interrupt();
      }
    });
    await move.start();
    expect(failureOf(move)).toEqual({
      message: copy.moveBackground("dream"),
      detail: null,
      actions: ["retry", "resume_source"],
      held: true,
    });
    expect(w.server.session.status).toBe("moving");
    await move.retry();
    expect(move.phase.step).toBe("done");
  });
});

describe("the move, at the target's door", () => {
  it("a Claude on the target took the conversation meanwhile: held until it closes there", async () => {
    const w = world();
    w.target.endRefusals = ["conversation_live_here"];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(failureOf(move)).toEqual({
      message:
        "Claude Code on mac has this conversation open. Close it there, then try again. Nothing was lost — it's still on dream.",
      detail: null,
      actions: ["retry", "resume_source"],
      held: true,
    });
    await move.retry();
    expect(move.phase.step).toBe("done");
    // Staging was kept: only the end went again.
    expect(w.source.exportCalls).toEqual([0, 4]);
  });

  it("a code this build does not know is said in words, never shown", async () => {
    const w = world();
    w.target.importRefusals = ["staging_on_fire"];
    const { move, phases } = run(w, (await ready(w)).plan);
    await move.start();
    expect(failureOf(move).message).toBe(
      "The conversation couldn't be copied to mac. Nothing was lost — it's still on dream.",
    );
    expect(shown(phases)).not.toContain("staging_on_fire");
  });
});

describe("the move, after the target committed: never undone", () => {
  it("a target offline at the commit is retried until it lands", async () => {
    const w = world();
    w.server.knobs.commitErrors = [
      { status: 409, detail: "target_offline" },
      { status: 409, detail: "target_offline" },
    ];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(move.phase.step).toBe("done");
    expect(w.log).not.toContain("server:abort");
    expect(w.typable(SESSION_ID, TARGET_ID)).not.toBeNull();
  });

  it("still offline after its tries: held with Try again — no cancel offered or said — and nothing left to type", async () => {
    const w = world();
    w.server.knobs.commitErrors = Array.from({ length: 3 }, () => ({
      status: 409,
      detail: "target_offline",
    }));
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(failureOf(move)).toEqual({
      message:
        "mac went offline before the move finished. Try again when it's back — nothing was lost.",
      detail: null,
      actions: ["retry", "close"],
      held: true,
    });
    // The resume line waited on a commit that never answered: it is gone,
    // so no later opening of the window can type it into a live Claude.
    expect(w.launches.size).toBe(0);
    await move.putBack();
    expect(move.phase.step).toBe("done");
    expect(w.log).not.toContain("server:abort");
    expect(w.log).not.toContain("source:conv.retire.abort");
    expect(w.typable(SESSION_ID, TARGET_ID)).not.toBeNull();
  });

  it("Close mid-commit drops the resume line it had queued", async () => {
    const w = world();
    const { move } = run(w, (await ready(w)).plan);
    w.server.commit = async () => {
      move.dispose();
      throw new Error("never answered");
    };
    await move.start();
    expect(w.queued).toHaveLength(1);
    expect(w.launches.size).toBe(0);
  });

  it("background mid-commit: told it only goes forward, nothing left to type", async () => {
    const w = world();
    w.server.knobs.commitErrors = [{ status: 0, detail: "network_error" }];
    const { move } = run(w, (await ready(w)).plan);
    move.subscribe((phase) => {
      if (phase.step === "starting") move.interrupt();
    });
    await move.start();
    expect(failureOf(move)).toEqual({
      message: copy.moveBackgroundCommitted("mac"),
      detail: null,
      actions: ["retry", "close"],
      held: true,
    });
    expect(w.launches.size).toBe(0);
  });

  it("put back underneath the carry by a resolver: begun again and committed, never 'finished elsewhere'", async () => {
    const w = world();
    const plan = (await ready(w)).plan;
    // The retire stops the window; before the source writes its record,
    // another device's Resolve finds none and ends the server's move.
    w.source.onStopped = () => {
      w.server.exited();
      void w.server.abort(SESSION_ID, SOURCE_ID);
    };
    const { move } = run(w, plan);
    await move.start();
    expect(move.phase).toMatchObject({ step: "done", outcome: "launched" });
    expect(w.server.session.host_id).toBe(TARGET_ID);
    expect(w.server.session.status).toBe("starting");
    expect(w.log.filter((entry) => entry === "server:begin")).toHaveLength(2);
    expect(w.typable(SESSION_ID, TARGET_ID)).not.toBeNull();
    expect(w.target.landed()).toBe(true);
  });

  it("finished by another device first: done, and nothing typed here", async () => {
    const w = world();
    const plan = (await ready(w)).plan;
    const { move } = run(w, plan);
    const commit = w.server.commit.bind(w.server);
    let first = true;
    w.server.commit = async (id, body) => {
      if (first) {
        first = false;
        // Another device's resolver committed the same carry a moment before.
        await commit(id, body);
        throw new ApiError(409, "http_409", "move_conflict", "move_conflict");
      }
      return commit(id, body);
    };
    await move.start();
    expect(move.phase).toMatchObject({ step: "done", outcome: "landed" });
    expect(w.typable(SESSION_ID, TARGET_ID)).toBeNull();
  });

  it("a commit whose answer was lost and then reads as settled: this device's own, its resume typed", async () => {
    const w = world();
    const { move } = run(w, (await ready(w)).plan);
    const commit = w.server.commit.bind(w.server);
    let first = true;
    w.server.commit = async (id, body) => {
      const moved = await commit(id, body);
      if (first) {
        first = false;
        throw new ApiError(0, "network_error", "lost");
      }
      return moved;
    };
    await move.start();
    expect(move.phase).toMatchObject({ step: "done", outcome: "launched" });
    expect(w.typable(SESSION_ID, TARGET_ID)).not.toBeNull();
  });

  it("put back and not to be begun again: the conversation is on the target, and the window is taken there", async () => {
    const w = world();
    const plan = (await ready(w)).plan;
    w.source.onStopped = () => {
      w.server.exited();
      void w.server.abort(SESSION_ID, SOURCE_ID).then(() => {
        // The source then goes offline: a begin there is refused.
        w.server.knobs.beginError = { status: 409, detail: "source_offline" };
      });
    };
    const { move } = run(w, plan);
    await move.start();
    expect(failureOf(move)).toEqual({
      message:
        "The conversation is on mac now, but this window isn't. Take the window to mac to carry on there.",
      detail: null,
      actions: ["take_there", "close"],
      held: false,
    });
    expect(w.launches.size).toBe(0);
    await move.takeThere();
    expect(move.phase).toMatchObject({ step: "done", outcome: "launched" });
    expect(w.server.commits.at(-1)).toEqual({
      host_id: TARGET_ID,
      cwd: "~/code/spawn",
      expected_host_id: SOURCE_ID,
      agent_id: "agent-1",
      agent_session_id: CONVERSATION_ID,
    });
    expect(w.server.session.host_id).toBe(TARGET_ID);
    expect(w.typable(SESSION_ID, TARGET_ID)).not.toBeNull();
  });

  it("a window closed before its launch went out: nothing typed", async () => {
    const w = world();
    w.server.knobs.commitErrors = [{ status: 404, detail: "session not found" }];
    const { move } = run(w, (await ready(w)).plan);
    await move.start();
    expect(failureOf(move).message).toBe(
      "The conversation moved to mac, but this window was closed meanwhile.",
    );
    expect(w.launches.size).toBe(0);
  });
});
