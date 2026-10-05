import type { MoveArrival } from "@/components/launcher/pending-agent-input";
import {
  ARRIVAL_MAX_MS,
  ARRIVAL_WAIT_MS,
  ARRIVAL_WATCH_MS,
  giveUp,
  RETRY_SETTLE_MS,
  retryResume,
  startArrival,
  stepArrival,
} from "@/components/terminal-ui/move-arrival";

const base: MoveArrival = {
  version: 1,
  agent: "Claude Code",
  to: "mac",
  from: "dream",
  cwd: "~/code/spawn",
  note: { text: "[SPAWN D: moved…] ", delivery: "typed_no_enter" },
  line: "claude --resume 6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60 --permission-mode default",
};

describe("after the resume line", () => {
  it("an idle note is typed at the ready prompt and never sent", () => {
    let state = startArrival(base, 0);
    expect(state.guard).toBe(true);
    ({ state } = stepArrival(state, "unknown", 600));
    ({ state } = stepArrival(state, "busy", 1_200));
    const step = stepArrival(state, "agent_ready", 1_800);
    expect(step.effects).toEqual([{ kind: "type", text: "[SPAWN D: moved…] " }, { kind: "focus" }]);
    expect(step.state).toMatchObject({ placed: true, done: true, guard: false, banner: null });
  });

  it("a mid-turn note typed (a shell that cannot carry it) is sent", () => {
    const state = startArrival({ ...base, note: { text: "[SPAWN D] note", delivery: "typed" } }, 0);
    expect(stepArrival(state, "agent_ready", 1).effects).toEqual([
      { kind: "type", text: "[SPAWN D] note" },
      { kind: "enter" },
    ]);
  });

  it("a note on the line types nothing, but dialogs still get their banner", () => {
    let state = startArrival({ ...base, note: { text: "x", delivery: "positional" } }, 0);
    expect(state.guard).toBe(false);
    let step = stepArrival(state, "trust_prompt", 1);
    expect(step.effects).toEqual([]);
    expect(step.state.banner).toEqual({
      kind: "dialog",
      message:
        "Claude Code on mac is asking whether to trust ~/code/spawn. Answer in the terminal to continue.",
    });
    state = step.state;
    step = stepArrival(state, "agent_ready", 2);
    expect(step.effects).toEqual([]);
    expect(step.state).toMatchObject({ done: true, banner: null });
  });

  it.each([
    [
      "bypass_prompt",
      "Claude Code on mac is asking you to confirm Bypass Permissions mode. Answer in the terminal to continue.",
    ],
    [
      "resume_summary_prompt",
      "Claude Code is asking how to pick this long conversation back up. Choose in the terminal.",
    ],
    ["login_required", "Claude Code on mac isn't signed in. Sign in in the terminal."],
    ["dialog", "Claude Code on mac is asking a question. Answer in the terminal to continue."],
  ] as const)("%s is answered by the person, never by a key", (screen, message) => {
    const step = stepArrival(startArrival(base, 0), screen, 1);
    expect(step.effects).toEqual([]);
    expect(step.state.banner).toEqual({ kind: "dialog", message });
    expect(step.state.done).toBe(false);
  });

  it("a question lowers the guard while it is up, so its banner and the keys are the person's", () => {
    let state = startArrival(base, 0);
    expect(state.guard).toBe(true);
    ({ state } = stepArrival(state, "trust_prompt", 600));
    expect(state).toMatchObject({ guard: false, banner: { kind: "dialog" } });
    ({ state } = stepArrival(state, "unknown", 1_200));
    expect(state).toMatchObject({ guard: true, banner: null });
    const step = stepArrival(state, "agent_ready", 1_800);
    expect(step.effects[0]).toEqual({ kind: "type", text: "[SPAWN D: moved…] " });
  });

  it("a dialog extends the wait, never past the cap", () => {
    let state = startArrival(base, 0);
    ({ state } = stepArrival(state, "trust_prompt", ARRIVAL_WAIT_MS - 1));
    expect(state.deadline).toBe(2 * ARRIVAL_WAIT_MS - 1);
    ({ state } = stepArrival(state, "trust_prompt", ARRIVAL_MAX_MS));
    expect(state.deadline).toBe(ARRIVAL_MAX_MS);
  });

  it("past the wait the terminal is left alone and the note offered to copy", () => {
    const { state } = stepArrival(startArrival(base, 0), "unknown", ARRIVAL_WAIT_MS);
    expect(state).toMatchObject({
      done: true,
      guard: false,
      banner: {
        kind: "note_failed",
        message: "SPAWN D couldn't add the move note to Claude Code's prompt.",
      },
    });
    expect(giveUp(startArrival(base, 0)).banner?.kind).toBe("note_failed");
  });

  it("no conversation found waits for Try again, which retypes the line", () => {
    let { state } = stepArrival(startArrival(base, 0), "conversation_not_found", 1);
    expect(state.banner).toEqual({
      kind: "not_found",
      message: "Claude Code on mac couldn't find the conversation.",
    });
    ({ state } = stepArrival(state, "unknown", ARRIVAL_WAIT_MS * 2));
    expect(state.banner?.kind).toBe("not_found");
    const retry = retryResume(state, 10);
    expect(retry.effects).toEqual([{ kind: "type", text: base.line }, { kind: "enter" }]);
    expect(retry.state).toMatchObject({
      done: false,
      banner: null,
      deadline: 10 + ARRIVAL_WAIT_MS,
    });
  });

  it("after no conversation found, a Claude the person starts by hand is never typed into", () => {
    let { state } = stepArrival(startArrival(base, 0), "conversation_not_found", 1);
    expect(state.done).toBe(true);
    const later = stepArrival(state, "agent_ready", 30_000);
    expect(later.effects).toEqual([]);
    ({ state } = later);
    expect(state).toMatchObject({ placed: false, banner: { kind: "not_found" } });
  });

  it("a note that rode the line is watched a minute for questions", () => {
    const state = startArrival({ ...base, note: { text: "x", delivery: "positional" } }, 0);
    expect(state.deadline).toBe(ARRIVAL_WATCH_MS);
    expect(startArrival(base, 0).deadline).toBe(ARRIVAL_WAIT_MS);
    expect(stepArrival(state, "unknown", ARRIVAL_WAIT_MS).state.done).toBe(false);
    expect(stepArrival(state, "unknown", ARRIVAL_WATCH_MS).state.done).toBe(true);
  });

  it("after Try again, the error it was pressed on is stale until the screen moves on", () => {
    let { state } = stepArrival(startArrival(base, 0), "conversation_not_found", 1);
    ({ state } = retryResume(state, 1_000));
    // The echo of the line typed again has not reached the screen yet.
    ({ state } = stepArrival(state, "conversation_not_found", 1_600));
    expect(state.banner).toBeNull();
    expect(state.done).toBe(false);
    // It has; the new line then fails too, and that is said.
    ({ state } = stepArrival(state, "unknown", 2_200));
    ({ state } = stepArrival(state, "conversation_not_found", 2_800));
    expect(state.banner?.kind).toBe("not_found");
  });

  it("after Try again, a failure read before anything else is said once the screen has had time", () => {
    let { state } = stepArrival(startArrival(base, 0), "conversation_not_found", 1);
    ({ state } = retryResume(state, 1_000));
    ({ state } = stepArrival(state, "conversation_not_found", 1_000 + RETRY_SETTLE_MS - 1));
    expect(state.banner).toBeNull();
    ({ state } = stepArrival(state, "conversation_not_found", 1_000 + RETRY_SETTLE_MS));
    expect(state.banner?.kind).toBe("not_found");
  });

  it("no claude on the host ends it", () => {
    const { state } = stepArrival(startArrival(base, 0), "agent_missing", 1);
    expect(state).toMatchObject({
      done: true,
      banner: { kind: "missing", message: "Claude Code isn't installed on mac." },
    });
  });
});
