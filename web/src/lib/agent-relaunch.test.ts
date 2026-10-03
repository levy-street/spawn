import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  agentLaunchCommand,
  agentResumeCommand,
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
  limits: { longest_note_code_points: number };
  shells: { login_shell: string | null; family: ShellFamily }[];
  quoting: { family: ShellFamily; value: string; quoted: string }[];
  host_names: { name: string; shown: string }[];
  os: { os: string | null; shown: string | null }[];
  paths: { path: string | null; shown: string | null }[];
  notes: { name: string; facts: RawFacts; note: string }[];
  delivery: { agent_kind: string; shell: string | null; state: string; delivery: NoteDelivery }[];
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

function plan(entry: RelaunchCase, agent: RelaunchAgent = entry.agent): RelaunchPlan | null {
  return planRelaunch({
    agent,
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
        delivery: noteDelivery(entry.agent_kind, shellFamily(entry.shell), entry.state),
      }).toEqual(entry);
    }
  });

  test.each(vectors.relaunch.map((entry) => [entry.name, entry]))("relaunch: %s", (_, entry) => {
    expect(plan(entry)).toEqual(entry.plan);
  });

  test("no note is longer than the vectors' longest", () => {
    const longest = Math.max(...vectors.notes.map((entry) => Array.from(entry.note).length));
    expect(longest).toBe(vectors.limits.longest_note_code_points);
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

// What the vectors say a shell does with a quoted word, asked of the shells
// installed here. Each is skipped where it is missing; CI images differ.
const SHELLS: { family: ShellFamily; name: string; run: (script: string) => string[] }[] = [
  { family: "posix", name: "bash", run: (script) => ["-c", script] },
  { family: "posix", name: "dash", run: (script) => ["-c", script] },
  { family: "posix", name: "zsh", run: (script) => ["-f", "-c", script] },
  { family: "posix", name: "ksh", run: (script) => ["-c", script] },
  { family: "fish", name: "fish", run: (script) => ["--no-config", "-c", script] },
  {
    family: "pwsh",
    name: "pwsh",
    run: (script) => ["-NoProfile", "-NonInteractive", "-Command", script],
  },
];

/** A program that prints each argument it is given on its own line. */
function printer(family: ShellFamily): string {
  return family === "pwsh" ? "& /usr/bin/printf '%s\\n'" : "printf '%s\\n'";
}

function evaluate(shell: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: [shell, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${shell}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

describe.each(SHELLS)("$name", ({ family, name, run }) => {
  const shell = Bun.which(name);

  test.skipIf(!shell)("reads every quoted word back as the value it quotes", () => {
    for (const entry of vectors.quoting.filter((candidate) => candidate.family === family)) {
      // zsh expands a bare word (or assignment value) that starts with `=` to
      // a command's path. The POSIX rule passes such a word bare, as every
      // line typed before this module did; proto/README.md names the gap.
      if (name === "zsh" && entry.quoted.startsWith("=")) continue;
      expect(evaluate(shell!, run(`${printer(family)} ${entry.quoted}`))).toBe(`${entry.value}\n`);
    }
  });

  test.skipIf(!shell)("hands the agent a positional note exactly as composed", () => {
    const positional = vectors.relaunch.filter(
      (entry) => entry.plan?.note?.delivery === "positional" && shellFamily(entry.shell) === family,
    );
    expect(positional.length).toBeGreaterThan(0);
    for (const entry of positional) {
      const printed = plan(entry, { ...entry.agent, command: printer(family) });
      const argv = evaluate(shell!, run(printed?.line ?? "")).split("\n");
      expect(argv.at(-2)).toBe(entry.plan?.note?.text);
      expect(argv).toContain("--permission-mode");
    }
  });
});
