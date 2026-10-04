import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentLaunchCommand,
  agentResumeCommand,
  canonicalConversationId,
  composeMoveNote,
  type MoveNoteFacts,
  type MoveNoteHost,
  type NoteDelivery,
  noteDelivery,
  noteHostName,
  noteOs,
  notePath,
  planRelaunch,
  type RelaunchAgent,
  type RelaunchConversation,
  type RelaunchPlan,
  type ShellFamily,
  shellFamily,
  shellQuote,
} from "@/lib/agent-relaunch";

// The vectors are the contract with the phone's copy of this module, which
// runs the same cases (mobile/src/data/selectors/__tests__/agent-relaunch.test.ts).
interface RawFacts {
  from: MoveNoteHost;
  to: MoveNoteHost;
  cwd: string | null;
  memory_path: string | null;
  state: string | null;
}

interface RelaunchCase {
  name: string;
  agent: RelaunchAgent;
  conversation: RelaunchConversation;
  permission_mode: string | null;
  shell: string | null;
  note: RawFacts | null;
  plan: RelaunchPlan | null;
}

interface Vectors {
  limits: { longest_note_code_points: number; positional_line_bytes: number };
  shells: { login_shell: string | null; family: ShellFamily }[];
  conversation_ids: { id: string | null; canonical: string | null }[];
  quoting: { family: ShellFamily; value: string; quoted: string }[];
  host_names: { name: string; shown: string }[];
  os: { os: string | null; shown: string | null }[];
  paths: { path: string | null; shown: string | null }[];
  notes: { name: string; facts: RawFacts; note: string }[];
  delivery: {
    agent_kind: string;
    shell: string | null;
    state: string;
    os: string | null;
    delivery: NoteDelivery;
  }[];
  relaunch: RelaunchCase[];
}

const vectors = JSON.parse(
  readFileSync(new URL("../../../proto/agent-note-vectors.json", import.meta.url), "utf8"),
) as Vectors;

function facts(raw: RawFacts): MoveNoteFacts {
  return {
    from: raw.from,
    to: raw.to,
    cwd: raw.cwd,
    memoryPath: raw.memory_path,
    state: raw.state,
  };
}

function plan(entry: RelaunchCase): RelaunchPlan | null {
  return planRelaunch({
    agent: entry.agent,
    conversation: entry.conversation,
    permissionMode: entry.permission_mode,
    shell: entry.shell,
    note: entry.note ? facts(entry.note) : null,
  });
}

describe("proto/agent-note-vectors.json", () => {
  test.each(
    vectors.shells.map((entry) => [String(entry.login_shell), entry]),
  )("login shell %s", (_, entry) => {
    expect(shellFamily(entry.login_shell)).toBe(entry.family);
  });

  test.each(
    vectors.conversation_ids.map((entry) => [JSON.stringify(entry.id), entry]),
  )("conversation id %s", (_, entry) => {
    expect(canonicalConversationId(entry.id)).toBe(entry.canonical);
  });

  test.each(
    vectors.quoting.map((entry) => [`${entry.family} ${entry.value}`, entry]),
  )("quotes %s", (_, entry) => {
    expect(shellQuote(entry.value, entry.family)).toBe(entry.quoted);
  });

  test.each(
    vectors.host_names.map((entry) => [JSON.stringify(entry.name), entry]),
  )("host name %s", (_, entry) => {
    expect(noteHostName(entry.name, "another host")).toBe(entry.shown);
  });

  test("OS names", () => {
    for (const entry of vectors.os) expect(noteOs(entry.os)).toBe(entry.shown);
  });

  test.each(
    vectors.paths.map((entry) => [JSON.stringify(entry.path), entry]),
  )("folder %s", (_, entry) => {
    expect(notePath(entry.path)).toBe(entry.shown);
  });

  test.each(vectors.notes.map((entry) => [entry.name, entry]))("note: %s", (_, entry) => {
    expect(composeMoveNote(facts(entry.facts))).toBe(entry.note);
  });

  test("delivery", () => {
    for (const entry of vectors.delivery) {
      expect({
        ...entry,
        delivery: noteDelivery(entry.agent_kind, shellFamily(entry.shell), entry.state, entry.os),
      }).toEqual(entry);
    }
  });

  test.each(vectors.relaunch.map((entry) => [entry.name, entry]))("relaunch: %s", (_, entry) => {
    expect(plan(entry)).toEqual(entry.plan);
  });
});

const ID = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";
const claude: RelaunchAgent = { kind: "claude-code", command: "claude", env: {} };
const agents: RelaunchAgent[] = [
  claude,
  { ...claude, yolo: true, yolo_args: "--dangerously-skip-permissions" },
  { kind: "codex", command: "codex", env: {} },
];
const running: MoveNoteFacts = {
  from: { name: "dream", os: "linux" },
  to: { name: "mac", os: "darwin" },
  cwd: "~/code/spawn",
  state: "running",
};

describe("the module's own bounds", () => {
  test("no note is longer than the limit, which the longest possible note reaches", () => {
    const limit = vectors.limits.longest_note_code_points;
    const lengths: number[] = [];
    for (const from of ["linux", "darwin", "windows", null]) {
      for (const to of ["linux", "darwin", "windows", null]) {
        for (const state of ["running", "blocked", "idle"]) {
          const note = composeMoveNote({
            from: { name: "a".repeat(60), os: from },
            to: { name: "b".repeat(60), os: to },
            cwd: `/${"c".repeat(159)}`,
            memoryPath: `/${"m".repeat(159)}`,
            state,
          });
          lengths.push(Array.from(note).length);
        }
      }
    }
    expect(Math.max(...lengths)).toBe(limit);
    for (const entry of vectors.notes) {
      expect(Array.from(entry.note).length).toBeLessThanOrEqual(limit);
    }
  });

  test("a note rides the line only within the line's byte budget", () => {
    const budget = vectors.limits.positional_line_bytes;
    const seen = new Set<NoteDelivery>();
    for (let length = 0; length <= 150; length += 1) {
      const result = planRelaunch({
        agent: claude,
        conversation: { resume: ID },
        permissionMode: "default",
        shell: "/bin/zsh",
        note: { ...running, cwd: `~/${"é".repeat(length)}`, memoryPath: `/${"m".repeat(150)}` },
      });
      const delivery = result?.note?.delivery;
      if (delivery) seen.add(delivery);
      if (delivery === "positional") {
        expect(new TextEncoder().encode(result?.line).length).toBeLessThanOrEqual(budget);
      } else {
        expect(result?.line).toBe(`claude --resume ${ID} --permission-mode default`);
      }
    }
    expect([...seen].sort()).toEqual(["positional", "typed"]);
  });

  test("an id that is not a canonical UUID is never typed: it is no id at all", () => {
    const rejected = vectors.conversation_ids.filter((entry) => entry.canonical === null);
    expect(rejected.map((entry) => entry.id)).toContain("--dangerously-skip-permissions");
    for (const { id } of rejected) {
      for (const agent of agents) {
        for (const shell of [null, "/bin/bash", "fish", "pwsh"]) {
          for (const permissionMode of [null, "default"]) {
            for (const note of [null, running]) {
              const ask = (conversation: RelaunchConversation) =>
                planRelaunch({ agent, conversation, permissionMode, shell, note });
              expect(ask({ resume: id })).toEqual(ask({ resume: null }));
              expect(ask({ start: id })).toEqual(ask({ start: null }));
            }
          }
        }
      }
    }
  });
});

describe("Restart's lines", () => {
  // Restart asks for no shell, no mode and no note: the lines it has always
  // typed, which the restart tests pin from the other side.
  const restarts = vectors.relaunch.filter(
    (entry) => entry.permission_mode === null && entry.shell === null && entry.note === null,
  );

  test("come from the same composer as every other relaunch", () => {
    expect(restarts.length).toBeGreaterThan(10);
    for (const entry of restarts) {
      if ("start" in entry.conversation) {
        expect(agentLaunchCommand(entry.agent, entry.conversation.start)).toBe(
          entry.plan?.line ?? "",
        );
      } else {
        expect(agentResumeCommand(entry.agent, entry.conversation.resume)).toBe(
          entry.plan?.line ?? null,
        );
      }
    }
  });
});

test("the phone carries this module byte for byte", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  expect(read("../../../mobile/src/data/selectors/agent-relaunch.ts")).toBe(
    read("./agent-relaunch.ts"),
  );
});

// What the vectors say a shell does with what it is typed, asked of the
// shells installed here, each in one process for every case (a cold start per
// case is seconds of PowerShell). A shell that is missing is skipped; CI
// images differ, and GitHub's Ubuntu image carries pwsh. `claude` on the
// shells' PATH is a stand-in that prints each argument it is given, so the
// vectors' own lines run exactly as a device types them.
const SHELLS: { name: string; family: ShellFamily; argv: (script: string) => string[] }[] = [
  { name: "bash", family: "posix", argv: (script) => ["-c", script] },
  { name: "dash", family: "posix", argv: (script) => ["-c", script] },
  { name: "zsh", family: "posix", argv: (script) => ["-f", "-c", script] },
  { name: "mksh", family: "posix", argv: (script) => ["-c", script] },
  { name: "busybox", family: "posix", argv: (script) => ["sh", "-c", script] },
  { name: "ksh", family: "ksh", argv: (script) => ["-c", script] },
  { name: "fish", family: "fish", argv: (script) => ["--no-config", "-c", script] },
  {
    name: "pwsh",
    family: "pwsh",
    argv: (script) => ["-NoProfile", "-NonInteractive", "-Command", script],
  },
];
/** Generous: one process per shell, but a CI runner's first pwsh is slow. */
const SHELL_TIMEOUT_MS = 60_000;
const RECORD = "\x1e";

const standIn = mkdtempSync(join(tmpdir(), "spawn-relaunch-"));
writeFileSync(join(standIn, "claude"), "#!/bin/sh\nprintf '%s\\0' \"$@\"\nprintf '\\036'\n");
chmodSync(join(standIn, "claude"), 0o755);
afterAll(() => rmSync(standIn, { recursive: true, force: true }));

/** Every argument `claude` was given, one list per line the script ran. */
function argvs(shell: string, argv: string[]): string[][] {
  const result = Bun.spawnSync({
    cmd: [shell, ...argv],
    env: { ...process.env, PATH: `${standIn}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`${shell}: ${result.stderr.toString()}`);
  const records = result.stdout.toString().split(RECORD);
  expect(records.pop()).toBe("");
  return records.map((record) => record.split("\0").slice(0, -1));
}

describe.each(SHELLS)("$name, where it is installed", ({ name, family, argv }) => {
  const shell = Bun.which(name);
  const spelling = family === "fish" || family === "pwsh" ? family : "posix";

  test.skipIf(!shell)(
    "reads every quoted word back as the value it quotes",
    () => {
      // zsh expands a bare word that starts with `=` to a command's path. The
      // POSIX rule passes such a word bare, as every line typed before this
      // module did; proto/README.md names the gap.
      const cases = vectors.quoting.filter(
        (entry) => entry.family === spelling && !(name === "zsh" && entry.quoted.startsWith("=")),
      );
      const script = cases.map((entry) => `claude ${entry.quoted}`).join("\n");
      expect(argvs(shell!, argv(script))).toEqual(cases.map((entry) => [entry.value]));
    },
    SHELL_TIMEOUT_MS,
  );

  const positional = vectors.relaunch.filter(
    (entry) => entry.plan?.note?.delivery === "positional" && shellFamily(entry.shell) === family,
  );
  if (family === "ksh") {
    test("never carries a note on the line", () => expect(positional).toEqual([]));
    return;
  }

  test.skipIf(!shell)(
    "hands the agent a positional note exactly as composed",
    () => {
      expect(positional.length).toBeGreaterThan(0);
      const lines = positional.map((entry) => entry.plan?.line ?? "");
      // Windows PowerShell's way of passing arguments drops a `"`, which is why
      // no note holds one; the notes read back the same under it.
      const script =
        family === "pwsh"
          ? [...lines, "$PSNativeCommandArgumentPassing = 'Legacy'", ...lines].join("\n")
          : lines.join("\n");
      const expected = family === "pwsh" ? [...positional, ...positional] : positional;
      const got = argvs(shell!, argv(script));
      expect(got.length).toBe(expected.length);
      got.forEach((args, index) => {
        expect(args.at(-1)).toBe(expected[index]?.plan?.note?.text);
        expect(args.slice(-3, -1)).toEqual(["--permission-mode", "default"]);
      });
    },
    SHELL_TIMEOUT_MS,
  );
});
