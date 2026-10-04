import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
} from "@/data/selectors/agent-relaunch";

// The vectors are the contract with the browser's copy of this module, which
// runs the same cases (web/src/lib/agent-relaunch.test.ts) and also checks the
// two files are byte for byte the same and that real shells read its quoting
// back.
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
  readFileSync(resolve(__dirname, "../../../../../proto/agent-note-vectors.json"), "utf8"),
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

describe("proto/agent-note-vectors.json", () => {
  test.each(vectors.shells.map((entry) => [String(entry.login_shell), entry] as const))(
    "login shell %s",
    (_, entry) => {
      expect(shellFamily(entry.login_shell)).toBe(entry.family);
    },
  );

  test.each(vectors.conversation_ids.map((entry) => [JSON.stringify(entry.id), entry] as const))(
    "conversation id %s",
    (_, entry) => {
      expect(canonicalConversationId(entry.id)).toBe(entry.canonical);
    },
  );

  test.each(vectors.quoting.map((entry) => [`${entry.family} ${entry.value}`, entry] as const))(
    "quotes %s",
    (_, entry) => {
      expect(shellQuote(entry.value, entry.family)).toBe(entry.quoted);
    },
  );

  test.each(vectors.host_names.map((entry) => [JSON.stringify(entry.name), entry] as const))(
    "host name %s",
    (_, entry) => {
      expect(noteHostName(entry.name, "another host")).toBe(entry.shown);
    },
  );

  test("OS names", () => {
    for (const entry of vectors.os) expect(noteOs(entry.os)).toBe(entry.shown);
  });

  test.each(vectors.paths.map((entry) => [JSON.stringify(entry.path), entry] as const))(
    "folder %s",
    (_, entry) => {
      expect(notePath(entry.path)).toBe(entry.shown);
    },
  );

  test.each(vectors.notes.map((entry) => [entry.name, entry] as const))("note: %s", (_, entry) => {
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

  test.each(vectors.relaunch.map((entry) => [entry.name, entry] as const))(
    "relaunch: %s",
    (_, entry) => {
      expect(
        planRelaunch({
          agent: entry.agent,
          conversation: entry.conversation,
          permissionMode: entry.permission_mode,
          shell: entry.shell,
          note: entry.note ? facts(entry.note) : null,
        }),
      ).toEqual(entry.plan);
    },
  );
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
