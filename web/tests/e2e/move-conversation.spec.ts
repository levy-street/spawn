import { expect, type Page, test } from "@playwright/test";
import {
  type AppMockOptions,
  agent,
  DEFAULT_HOST_CAPABILITIES,
  HOST_ID,
  host,
  type MockConversations,
  mockApp,
  releaseExport,
  SESSION_B_ID,
  SESSION_ID,
  session,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";
import { handleSessionRtcSignal, installSessionRtcMock, sendPty } from "./session-rtc-mock";

// A Claude Code window on dream (Linux) moves to Mac (macOS) with its
// conversation, over the mock daemon pair's conversation carrier.

const DREAM_ID = "00000000-0000-4000-8000-0000000000d1";
const CLAUDE_ID = "00000000-0000-4000-8000-0000000000c1";
const CONVERSATION = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";
const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const CARRYING = [...DEFAULT_HOST_CAPABILITIES, "agent.transcripts", "conv.v1", "conv.v2"];

const dream = { ...host, id: DREAM_ID, name: "dream", os: "linux", home_dir: "/home/tester" };
const claude = agent({
  id: CLAUDE_ID,
  name: "Claude Code",
  kind: "claude-code",
  command: "claude",
  install: null,
  yolo_args: "--dangerously-skip-permissions",
});

function claudeWindow(overrides: Record<string, unknown> = {}) {
  return session({
    name: null,
    host_id: DREAM_ID,
    host_name: "dream",
    cwd: "/home/tester/code/spawn",
    foreground_command: "claude",
    agent_id: CLAUDE_ID,
    agent_session_id: CONVERSATION,
    ...overrides,
  });
}

/** A shell on Mac that is in no workspace: it makes ~/code/spawn on Mac a place. */
const macShell = session({
  id: SESSION_B_ID,
  name: "mac shell",
  host_id: HOST_ID,
  cwd: "/Users/tester/code/spawn",
});

/** Both folders on main at the same commit, read from .git through fs.read;
 *  Mac's Claude Code starts in accept edits unless told otherwise. */
function gitFiles(hostId: string, path: string): string {
  if (path.endsWith("/.git/HEAD")) return "ref: refs/heads/main\n";
  if (path.endsWith("/.git/refs/heads/main")) return `${SHA}\n`;
  if (hostId === HOST_ID && path === "~/.claude/settings.json")
    return '{"permissions":{"defaultMode":"acceptEdits"}}';
  throw new Error("host_error:not_found");
}

function ptyText(messages: Array<string | Buffer>): string {
  return messages
    .filter((message): message is Buffer => Buffer.isBuffer(message))
    .map((message) => message.toString("utf8"))
    .join("");
}

async function openMoveWorkspace(
  page: Page,
  {
    conversations = {},
    sourceOnline = true,
    window = claudeWindow(),
    ...options
  }: Omit<AppMockOptions, "conversations"> & {
    conversations?: MockConversations;
    sourceOnline?: boolean;
    window?: ReturnType<typeof session>;
  } = {},
) {
  const messages: Array<string | Buffer> = [];
  await installSessionRtcMock(page, messages, { history: "ready\r\n$ ", autoSnapshot: true });
  const store = await mockApp(page, {
    hosts: [{ ...dream, status: sourceOnline ? "online" : "offline" }, host],
    sessions: [window, macShell],
    agents: [claude],
    capabilities: CARRYING,
    fileRead: gitFiles,
    workspaces: [
      workspace({
        layout: { version: 3, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }] },
      }),
    ],
    conversations: {
      inspect: () => ({
        agent: "claude-code",
        conversation_id: CONVERSATION,
        state: "running",
        cli_version: "2.1.289",
        live_elsewhere: false,
        source: "registry",
      }),
      ...conversations,
    },
    ...options,
  });
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    ws.onMessage((message) => handleSessionRtcSignal(ws, message));
    ws.send(
      JSON.stringify({
        type: "rtc.config",
        enabled: true,
        ice_servers: [],
        binding_nonce_required: true,
      }),
    );
    ws.send(JSON.stringify({ type: "session.status", status: "running" }));
  });
  await page.goto(`/w/${WORKSPACE_ID}`);
  return { store, messages };
}

/** The pane menu's "Move to another host…", then the place on Mac. */
async function pickMac(page: Page) {
  await page.getByRole("button", { name: "Claude Code options" }).click();
  await page.getByRole("menuitem", { name: "Move to another host…" }).click();
  await page.getByRole("menuitem", { name: /~\/code\/spawn/ }).click();
}

test("the dialog checks both hosts, says what moves, and starts Claude in the mode picked", async ({
  page,
}) => {
  const { store, messages } = await openMoveWorkspace(page);
  await pickMac(page);
  const dialog = page.getByRole("dialog", { name: "Move Claude Code to Mac?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "Claude Code stops on dream and continues this conversation on Mac, in ~/code/spawn. The conversation comes with it (100 B); the files it was working on don't, so ~/code/spawn on Mac needs your latest work.",
  );
  await expect(dialog).toContainText(
    "Claude Code is working right now. On Mac it will be told about the move and carry on.",
  );
  await expect(dialog).toContainText("Both are on main at 1a2b3c4.");
  // The picker starts on Mac's own default, read from its settings.
  const mode = dialog.getByRole("combobox", { name: "Permission mode on arrival" });
  await expect(mode).toHaveValue("acceptEdits");
  await mode.selectOption("plan");
  await dialog.getByRole("button", { name: "Move with conversation" }).click();

  await expect(page.getByText("Moved to Mac — Claude Code is carrying on.")).toBeVisible();
  expect(store.requests.moves.map((move) => move.kind)).toEqual(["begin", "commit"]);
  expect(store.requests.moves[0]?.body).toEqual({ expected_host_id: DREAM_ID });
  expect(store.requests.moves[1]?.body).toMatchObject({
    host_id: HOST_ID,
    cwd: "/Users/tester/code/spawn",
    expected_host_id: DREAM_ID,
    agent_session_id: CONVERSATION,
    carried: true,
  });
  const asked = store.requests.conversations.map(
    (call) => `${call.hostId === DREAM_ID ? "dream" : "Mac"} ${call.operation}`,
  );
  expect(asked).toEqual(
    expect.arrayContaining([
      "dream conv.inspect",
      "Mac conv.probe",
      "dream conv.export",
      "Mac conv.import.begin",
      "dream conv.retire.commit",
    ]),
  );
  // A running Claude's note rides the line as its first prompt, in the
  // permission mode the person picked — never the one the record carried.
  await expect
    .poll(() => ptyText(messages))
    .toContain(
      `claude --resume ${CONVERSATION} --permission-mode plan '[SPAWN D] This conversation just moved from dream (Linux) to Mac (macOS)`,
    );
});

test("the copy shows its progress, and Cancel puts the conversation back on dream", async ({
  page,
}) => {
  let restarted = 0;
  const { store } = await openMoveWorkspace(page, {
    conversations: { bundle: "y".repeat(5 * 8192), holdAfterChunks: 2 },
    restartSession: async (id, route, current) => {
      restarted += 1;
      const row = current.sessions.find((item) => item.id === id);
      if (row) Object.assign(row, { status: "running" });
      await route.fulfill({ json: row });
    },
  });
  await pickMac(page);
  await page.getByRole("button", { name: "Move with conversation" }).click();
  const pane = page.getByRole("region", { name: "Moving to Mac…" });
  await expect(pane).toContainText("Copying the conversation · 16 of 40 KB");
  await expect(pane).toContainText("Keep SPAWN D open until the move finishes.");
  await pane.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Back on dream — nothing was lost.")).toBeVisible();
  const order = store.requests.conversations
    .map((call) => call.operation)
    .filter((operation) => operation === "conv.import.cancel" || operation === "conv.retire.abort");
  expect(order).toEqual(["conv.import.cancel", "conv.retire.abort"]);
  expect(store.requests.moves.map((move) => move.kind)).toEqual(["begin", "abort"]);
  // The retire stopped Claude: put back, the window is restarted there.
  await expect.poll(() => restarted).toBe(1);
  await releaseExport(page);
});

test("a target that refuses pauses with its reason, and Resume on dream puts it back", async ({
  page,
}) => {
  const { store } = await openMoveWorkspace(page, {
    conversations: {
      importBegin: () => {
        throw new Error("host_error:folder_missing");
      },
    },
  });
  await pickMac(page);
  await page.getByRole("button", { name: "Move with conversation" }).click();
  const pane = page.getByRole("region", { name: "Moving to Mac…" });
  await expect(pane.getByRole("alert")).toHaveText(
    "~/code/spawn doesn't exist on Mac. Create it there, then try again. Nothing was lost — it's still on dream.",
  );
  await expect(pane.getByRole("button", { name: "Try again" })).toBeVisible();
  await pane.getByRole("button", { name: "Resume on dream" }).click();
  await expect(page.getByText("Back on dream — nothing was lost.")).toBeVisible();
  expect(store.requests.moves.map((move) => move.kind)).toEqual(["begin", "abort"]);
});

test("a source that is offline says the conversation can't come along and offers a fresh start", async ({
  page,
}) => {
  const { store } = await openMoveWorkspace(page, { sourceOnline: false });
  await pickMac(page);
  const dialog = page.getByRole("dialog", { name: "Move Claude Code to Mac?" });
  await expect(dialog).toContainText(
    "dream is offline, so this conversation can't come along. Start a new one on Mac instead?",
  );
  await expect(dialog.getByRole("button", { name: "Move with conversation" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Start fresh on Mac" }).click();
  await expect.poll(() => store.requests.moves.map((move) => move.kind)).toEqual(["commit"]);
  expect(store.requests.moves[0]?.body.carried).toBeUndefined();
});

test("a window another device is moving reads Moving with Resolve as its only action", async ({
  page,
}) => {
  const { store } = await openMoveWorkspace(page, {
    window: claudeWindow({ status: "moving", activity_state: "moving", activity_label: "Moving" }),
  });
  const pane = page.getByRole("region", { name: "Moving to another host…" });
  await expect(pane).toBeVisible();
  await expect(page.getByRole("button", { name: /^Close / })).toHaveCount(0);
  await expect(page.getByText("Shell exited")).toHaveCount(0);
  await page.getByRole("button", { name: "Claude Code options" }).click();
  await expect(page.getByRole("menuitem", { name: "Restart" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Move to another host…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await pane.getByRole("button", { name: "Resolve" }).click();
  const dialog = page.getByRole("dialog", { name: "Finish or put back this move?" });
  await expect(dialog).toContainText("This window started moving from dream and didn't finish.");
  await dialog.getByRole("button", { name: "Resolve" }).click();
  await expect(dialog).toContainText("Checking dream…");
  // No record on dream is never believed at once: a retire writes its record
  // only once it has stopped the window. Read again after the stop's time,
  // with dream asked twice whether it still runs the window.
  await expect(dialog).toContainText("Back on dream — nothing was lost.", { timeout: 20_000 });
  expect(store.requests.moves.map((move) => move.kind)).toEqual(["abort"]);
  const operations = store.requests.conversations.map((call) => call.operation);
  expect(operations.filter((operation) => operation === "conv.transfers").length).toBeGreaterThan(
    1,
  );
  expect(operations.filter((operation) => operation === "conv.inspect")).toHaveLength(2);
});

test("a move whose host is gone for good can be given up, touching neither host", async ({
  page,
}) => {
  const GONE = "00000000-0000-4000-8000-0000000000ff";
  const { store } = await openMoveWorkspace(page, {
    window: claudeWindow({ status: "moving", activity_state: "moving", activity_label: "Moving" }),
    conversations: {
      transfers: () => ({
        outgoing: [
          {
            transfer_id: "44444444-4444-4444-8444-444444444444",
            conversation_id: CONVERSATION,
            session_id: SESSION_ID,
            to_host_id: GONE,
            state: "held",
            created_at: 1,
            length: 100,
            sha256: "a".repeat(64),
          },
        ],
        incoming: [],
        truncated: false,
      }),
    },
  });
  await page
    .getByRole("region", { name: "Moving to another host…" })
    .getByRole("button", { name: "Resolve" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Finish or put back this move?" });
  await dialog.getByRole("button", { name: "Resolve" }).click();
  await expect(dialog).toContainText(
    "The host it was going to can't be reached, so SPAWN D can't tell whether the conversation arrived.",
  );
  await expect(dialog).toContainText(
    "The window stops on dream. Its conversation stays where it is now — set aside on dream, or already on the host it was going to — until you resolve the move from dream's page.",
  );
  await dialog.getByRole("button", { name: "Give up the move" }).click();
  await expect(dialog).toContainText(
    "The move was given up and the window is back on dream. Resolve its conversation from dream's page once both hosts can be reached.",
  );
  expect(store.requests.moves.map((move) => move.kind)).toEqual(["abort"]);
  const operations = store.requests.conversations.map((call) => call.operation);
  expect(operations).not.toContain("conv.retire.abort");
  expect(operations).not.toContain("conv.import.cancel");
});

test("after the move Claude's trust question is said in the pane, never answered, and the idle note waits for the prompt", async ({
  page,
}) => {
  const { messages } = await openMoveWorkspace(page, {
    conversations: {
      inspect: () => ({
        agent: "claude-code",
        conversation_id: CONVERSATION,
        state: "idle",
        cli_version: "2.1.289",
        live_elsewhere: false,
        source: "registry",
      }),
    },
  });
  await pickMac(page);
  await page.getByRole("button", { name: "Move with conversation" }).click();
  await expect(
    page.getByText("Moved to Mac — your next message starts with a note about the move."),
  ).toBeVisible();
  // Mac's own default (its settings say accept edits): the mode it starts in.
  const line = `claude --resume ${CONVERSATION} --permission-mode acceptEdits`;
  await expect.poll(() => ptyText(messages)).toContain(line);
  // The guard is a live status, and it keeps keys away from the terminal.
  const guard = page.getByRole("status", { name: "Resuming the conversation…" });
  await expect(guard).toBeVisible();

  await sendPty(
    page,
    [
      "\x1b[2J\x1b[H",
      " Accessing workspace:\r\n",
      " /Users/tester/code/spawn\r\n",
      " Quick safety check: Is this a project you created or one you trust?\r\n",
      " ❯ No, exit\r\n",
      "   Yes, I trust this folder\r\n",
    ].join(""),
  );
  await expect(
    page.getByText(
      "Claude Code on Mac is asking whether to trust ~/code/spawn. Answer in the terminal to continue.",
    ),
  ).toBeVisible();
  const typedBefore = ptyText(messages);
  expect(typedBefore.slice(typedBefore.indexOf(line) + line.length)).toMatch(/^[\r\n]?$/);

  await sendPty(
    page,
    [
      "\x1b[2J\x1b[H",
      "● Picked up.\r\n",
      "────────────────────────────────────────\r\n",
      "❯\r\n",
      "────────────────────────────────────────\r\n",
      "  ? for shortcuts\r\n",
    ].join(""),
  );
  await expect
    .poll(() => ptyText(messages))
    .toContain(
      "[SPAWN D: moved from dream (Linux) to Mac (macOS), now in /Users/tester/code/spawn.",
    );
  const typed = ptyText(messages);
  // Idle: typed for the person's next message, never sent.
  expect(typed.endsWith("] ")).toBe(true);
});

test("a key pressed while the note waits takes the terminal back: nothing reaches the shell, the note is offered to copy", async ({
  page,
}) => {
  const { messages } = await openMoveWorkspace(page, {
    conversations: {
      inspect: () => ({
        agent: "claude-code",
        conversation_id: CONVERSATION,
        state: "idle",
        cli_version: "2.1.289",
        live_elsewhere: false,
        source: "registry",
      }),
    },
  });
  await pickMac(page);
  await page.getByRole("button", { name: "Move with conversation" }).click();
  const line = `claude --resume ${CONVERSATION} --permission-mode acceptEdits`;
  await expect.poll(() => ptyText(messages)).toContain(line);
  const guard = page.getByRole("status", { name: "Resuming the conversation…" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Use the terminal now" }).focus();
  await page.keyboard.press("q");
  await expect(guard).toHaveCount(0);
  await expect(
    page.getByText("SPAWN D couldn't add the move note to Claude Code's prompt."),
  ).toBeVisible();
  const typed = ptyText(messages);
  expect(typed.slice(typed.indexOf(line) + line.length)).not.toContain("q");
});
