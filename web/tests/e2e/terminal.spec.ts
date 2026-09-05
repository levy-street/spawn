import {
  devices,
  expect,
  type Locator,
  type Page,
  test,
  type WebSocketRoute,
} from "@playwright/test";
import {
  mockApp,
  pinKeyboard,
  SESSION_B_ID,
  SESSION_ID,
  session,
  WORKSPACE_ID,
  workspace,
} from "./app-mocks";
import {
  handleSessionRtcSignal,
  installSessionRtcMock,
  sendPty,
  setDisplayControl,
} from "./session-rtc-mock";

async function openTerminalWithMockSocket(
  page: Page,
  options: {
    control?: { owner: boolean; cols: number; rows: number; viewers: number };
    history?: string;
    reconnect?: boolean;
    secondHistory?: string;
    noChannels?: boolean;
    noReady?: boolean;
    autoSnapshot?: boolean;
    uploadFinalAction?: "complete" | "disconnect" | "hold";
    stallUploadBackpressure?: boolean;
    historyEpoch?: string;
    historyOffset?: number;
  } = {},
) {
  const messages: Array<string | Buffer> = [];
  const uploads: Array<{
    name: string;
    mimeType: string;
    destination: "attachments" | "cwd";
    bytes: Buffer;
  }> = [];
  await installSessionRtcMock(page, messages, {
    control: options.control,
    history: options.history,
    secondHistory: options.secondHistory,
    openChannels: !options.noChannels,
    sendReady: !options.noReady,
    autoSnapshot: options.autoSnapshot,
    uploadFinalAction: options.uploadFinalAction,
    stallUploadBackpressure: options.stallUploadBackpressure,
    historyEpoch: options.historyEpoch,
    historyOffset: options.historyOffset,
    onUpload: (upload) => {
      uploads.push(upload);
    },
  });
  await mockApp(page, {
    sessions: [session()],
    workspaces: [
      workspace({
        layout: {
          version: 3,
          tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }],
        },
      }),
    ],
  });
  const sockets: WebSocketRoute[] = [];

  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    sockets.push(ws);
    const index = sockets.length;
    ws.onMessage((message) => {
      messages.push(message);
      handleSessionRtcSignal(ws, message);
    });
    ws.send(
      JSON.stringify({
        type: "rtc.config",
        enabled: true,
        ice_servers: [],
        binding_nonce_required: true,
      }),
    );
    ws.send(JSON.stringify({ type: "session.status", status: "running" }));
    if (options.reconnect && index === 1) {
      setTimeout(() => {
        void ws.close({ code: 1001, reason: "test reconnect" });
      }, 100);
    }
  });

  await page.goto(`/sessions/${SESSION_ID}`);
  await expect(page.getByLabel("Session terminal")).toBeVisible();
  return { messages, sockets, uploads };
}

function binaryText(messages: Array<string | Buffer>) {
  return messages
    .filter(Buffer.isBuffer)
    .map((message) => (message as Buffer).toString("utf8"))
    .join("");
}

function jsonMessages(messages: Array<string | Buffer>) {
  return messages
    .filter((message): message is string => typeof message === "string")
    .map((message) => {
      try {
        const parsed = JSON.parse(message);
        return parsed?.kind === "request" && typeof parsed.operation === "string"
          ? { ...parsed, ...parsed.parameters, type: parsed.operation }
          : parsed;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function failReconciliationStorageAfter(page: Page, successfulWrites: number) {
  await page.addInitScript(
    ({ prefix, successfulWrites }) => {
      const originalSetItem = Storage.prototype.setItem;
      const originalRemoveItem = Storage.prototype.removeItem;
      let writes = 0;
      const shouldFail = (key: string) => key.startsWith(prefix) && writes++ >= successfulWrites;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (shouldFail(key)) throw new DOMException("test storage failure", "QuotaExceededError");
        return originalSetItem.call(this, key, value);
      };
      Storage.prototype.removeItem = function (key: string) {
        if (shouldFail(key)) throw new DOMException("test storage failure", "QuotaExceededError");
        return originalRemoveItem.call(this, key);
      };
      (
        window as unknown as { __spawnRestoreReconciliationStorage: () => void }
      ).__spawnRestoreReconciliationStorage = () => {
        Storage.prototype.setItem = originalSetItem;
        Storage.prototype.removeItem = originalRemoveItem;
      };
    },
    { prefix: "spawn.upload-reconciliation.v1:", successfulWrites },
  );
}

async function restoreReconciliationStorage(page: Page) {
  await page.evaluate(() => {
    (
      window as unknown as { __spawnRestoreReconciliationStorage: () => void }
    ).__spawnRestoreReconciliationStorage();
  });
}

async function failReconciliationHistoryFallback(page: Page) {
  await page.addInitScript(() => {
    const original = History.prototype.replaceState;
    History.prototype.replaceState = function (data: unknown, unused: string, url?: string | URL) {
      if (
        typeof data === "object" &&
        data !== null &&
        "__spawnUploadReconciliationFallback" in data
      ) {
        throw new DOMException("test history failure", "DataCloneError");
      }
      return original.call(this, data, unused, url);
    };
    (
      window as unknown as { __spawnRestoreReconciliationHistory: () => void }
    ).__spawnRestoreReconciliationHistory = () => {
      History.prototype.replaceState = original;
    };
  });
}

async function stallFirstUploadHash(page: Page) {
  await page.addInitScript(() => {
    const original = Blob.prototype.arrayBuffer;
    let first = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Blob.prototype.arrayBuffer = async function () {
      if (first) {
        first = false;
        await gate;
      }
      return original.call(this);
    };
    (
      window as unknown as { __spawnReleaseFirstUploadHash: () => void }
    ).__spawnReleaseFirstUploadHash = release;
  });
}

async function stallFinalUploadRead(page: Page) {
  await page.addInitScript(() => {
    const original = Blob.prototype.arrayBuffer;
    let uploadReads = 0;
    let finalReadStarted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Blob.prototype.arrayBuffer = async function () {
      uploadReads += 1;
      if (uploadReads === 2) {
        finalReadStarted = true;
        await gate;
      }
      return original.call(this);
    };
    (
      window as unknown as {
        __spawnFinalUploadReadGate: { started: () => boolean; release: () => void };
      }
    ).__spawnFinalUploadReadGate = {
      started: () => finalReadStarted,
      release,
    };
  });
}

function liveTerminal(page: Page) {
  return page.getByTestId("terminal-live-host").locator(".xterm");
}

function liveTerminalRows(page: Page) {
  return page.getByTestId("terminal-live-host").locator(".xterm-rows");
}

async function liveViewportMetrics(page: Page) {
  return page
    .getByTestId("terminal-live-host")
    .locator(".xterm-viewport")
    .evaluate((el) => {
      return {
        scrollTop: el.scrollTop,
        maxTop: Math.max(0, el.scrollHeight - el.clientHeight),
      };
    });
}

async function dragTouchInTerminal(
  page: Page,
  startYRatio: number,
  endYRatio: number,
  target?: Locator,
) {
  const box = await (target ?? liveTerminal(page)).boundingBox();
  if (!box) throw new Error("terminal is not visible");
  const x = Math.round(box.x + box.width / 2);
  const startY = Math.round(box.y + box.height * startYRatio);
  const endY = Math.round(box.y + box.height * endYRatio);
  const client = await page.context().newCDPSession(page);

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: startY, id: 1 }],
  });
  for (let i = 1; i <= 10; i += 1) {
    const y = Math.round(startY + ((endY - startY) * i) / 10);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, id: 1 }],
    });
    await page.waitForTimeout(16);
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

function longHistory(lines: number) {
  return `${Array.from({ length: lines }, (_, i) => {
    return `history-${String(i).padStart(3, "0")}`;
  }).join("\n")}\n`;
}

test("terminal renders ANSI color and sends keystrokes without refresh", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page);

  await expect(liveTerminalRows(page)).toContainText("RED");
  const redColor = await liveTerminalRows(page)
    .locator("span", { hasText: "RED" })
    .evaluate((node) => {
      return window.getComputedStyle(node).color;
    });
  expect(redColor).not.toBe("rgb(229, 229, 229)");

  await page.getByLabel("Session terminal").click();
  await page.keyboard.type("hello");

  await expect.poll(() => binaryText(messages)).toContain("hello");
});

test("shift+enter sends ESC CR exactly once (no trailing plain CR)", async ({ page }) => {
  // Claude-style TUIs bind ESC+CR to "insert newline"; a stray plain \r from
  // the same key press (keypress path) would submit the prompt instead.
  const { messages } = await openTerminalWithMockSocket(page, { history: "ready\n" });
  await page.getByLabel("Session terminal").click();
  await page.keyboard.press("Shift+Enter");
  await expect.poll(() => binaryText(messages)).toContain("\x1b\r");
  await page.keyboard.type("x");
  await expect.poll(() => binaryText(messages)).toContain("x");
  const bytes = binaryText(messages);
  expect(bytes.replace("\x1b\r", "")).not.toContain("\r");
});

test("on a Mac, ⌥ and ⌘ arrows are the shell's word and line keys", async ({ page }) => {
  // The two halves of Mac text navigation, which xterm.js only half provides:
  // it turns ⌥←/⌥→ into backward-word and forward-word itself, and drops every
  // ⌘ chord unread, so the ends of the line had to be put back by hand.
  await pinKeyboard(page, "apple");
  const { messages } = await openTerminalWithMockSocket(page, { history: "ready\n" });

  await page.getByLabel("Session terminal").click();
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowRight");
  await expect.poll(() => binaryText(messages)).toContain("\x1bb");
  expect(binaryText(messages)).toContain("\x1bf");

  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.press("Meta+ArrowRight");
  await expect.poll(() => binaryText(messages)).toContain("\x01");
  expect(binaryText(messages)).toContain("\x05");
});

test("terminal sends control keys without waiting for a refresh", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page, { history: "ready\n" });

  await page.getByLabel("Session terminal").click();
  await page.keyboard.press("Control+C");
  await page.keyboard.press("Enter");

  await expect.poll(() => binaryText(messages)).toContain("\x03");
  await expect.poll(() => binaryText(messages)).toContain("\r");
});

test("terminal attempts direct WebRTC transport when advertised", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page, { history: "ready\n" });

  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "rtc.offer"))
    .toMatchObject({
      type: "rtc.offer",
      session_id: expect.any(String),
      scope_type: "session",
      scope_id: SESSION_ID,
      protocol: "spawn.pty",
      protocol_version: 2,
      sdp: expect.stringContaining("v=0"),
    });
  // The handshake's subprotocol is not observable from here: page.routeWebSocket
  // intercepts the connection before the page's WebSocket constructor runs, so
  // nothing in the page ever sees it. `spawn.v3` is pinned in src/lib/ws.test.ts
  // instead, where it is actually checkable.
});

test("opening a terminal as viewer claims control automatically", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page, {
    control: { owner: false, cols: 156, rows: 38, viewers: 2 },
    history: "viewer\n",
  });

  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "take_control"))
    .toMatchObject({
      type: "take_control",
      cols: expect.any(Number),
      rows: expect.any(Number),
    });
  // Ownership is claimed optimistically, so no dimmed viewer overlay shows.
  await expect(page.getByRole("button", { name: "Take control" })).toHaveCount(0);
});

test("losing control dims the terminal and re-takes from the centered button", async ({ page }) => {
  // Opens as owner (default mock state) — the auto-claim never fires.
  const { messages } = await openTerminalWithMockSocket(page, { history: "owner\n" });
  await expect(liveTerminalRows(page)).toContainText("owner");
  expect(jsonMessages(messages).some((m) => m?.type === "take_control")).toBe(false);

  // Another session steals control: the pane dims with a centered button.
  await setDisplayControl(page, { owner: false, cols: 156, rows: 38, viewers: 2 });
  const button = page.getByRole("button", { name: "Take control" });
  await expect(button).toBeVisible();
  await expect(page.getByText("Another session has control · 156x38 · 2 viewers")).toBeVisible();

  await button.click();
  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "take_control"))
    .toMatchObject({ type: "take_control", cols: expect.any(Number), rows: expect.any(Number) });
  await expect(button).toHaveCount(0);
});

test("owner sees additional viewer count", async ({ page }) => {
  await openTerminalWithMockSocket(page, {
    control: { owner: true, cols: 120, rows: 32, viewers: 3 },
    history: "owner\n",
  });

  await expect(page.getByText("2 viewers")).toBeVisible();
});

test("terminal sends resize and chunked uploads over direct DataChannels", async ({ page }) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const test = (
          window as unknown as {
            __spawnRtcTest?: {
              channelReliability: (label: string) => {
                ordered: boolean;
                maxPacketLifeTime: number | null;
                maxRetransmits: number | null;
              } | null;
            };
          }
        ).__spawnRtcTest;
        return [test?.channelReliability("spawn.pty"), test?.channelReliability("spawn.ctl")];
      }),
    )
    .toEqual([
      { ordered: true, maxPacketLifeTime: null, maxRetransmits: null },
      { ordered: true, maxPacketLifeTime: null, maxRetransmits: null },
    ]);

  await expect
    .poll(() => jsonMessages(messages).some((message) => message?.type === "resize"))
    .toBe(true);

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello file") });

  await expect
    .poll(() => uploads.at(-1))
    .toMatchObject({
      destination: "cwd",
      name: "note.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("hello file"),
    });
  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "upload_start"))
    .toMatchObject({
      destination: "cwd",
      name: "note.txt",
      mime_type: "text/plain",
      total_bytes: 10,
      chunks: 1,
      capability: "00112233-4455-4677-8899-aabbccddeeff",
      agent_generation: 1,
    });
  await expect(page.getByText("Uploaded /Users/tester/projects/spawn/note.txt")).toBeVisible();
});

test("lost final upload acknowledgement is outcome_unknown and is never retried", async ({
  page,
}) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    uploadFinalAction: "disconnect",
  });

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "maybe.txt", mimeType: "text/plain", buffer: Buffer.from("published") });

  await expect.poll(() => uploads).toHaveLength(1);
  await expect(page.getByText(/may have been published/i)).toBeVisible();
  await page.waitForTimeout(250);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  expect(uploads).toHaveLength(1);
});

test("reconciliation capacity refuses the ninth upload before any endpoint effect", async ({
  page,
}) => {
  await page.addInitScript(
    ({ sessionId }) => {
      sessionStorage.setItem(
        `spawn.upload-reconciliation.v1:${sessionId}`,
        JSON.stringify(
          Array.from({ length: 8 }, (_, index) => ({
            uploadId: `retained-${index}`,
            fileName: `retained-${index}.txt`,
            message: "Reconcile before retrying.",
            recordedAt: index + 1,
            phase: "outcome_unknown",
          })),
        ),
      );
    },
    { sessionId: SESSION_ID },
  );
  const { messages, uploads } = await openTerminalWithMockSocket(page);
  await expect(page.getByTestId("upload-reconciliation").locator("strong")).toHaveCount(8);

  await page.locator('input[type="file"]').setInputFiles({
    name: "refused.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("must not reach endpoint"),
  });
  await expect(page.getByText(/reconciliation capacity is full/i)).toBeVisible();
  await page.waitForTimeout(100);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    0,
  );
  expect(
    jsonMessages(messages).filter((message) => message?.type === "upload_cancel"),
  ).toHaveLength(0);
  expect(uploads).toHaveLength(0);
  await expect(page.getByTestId("upload-reconciliation").locator("strong")).toHaveCount(8);

  await page.getByRole("button", { name: "Dismiss retained-0.txt after checking" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "accepted.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("accepted"),
  });
  await expect.poll(() => uploads).toHaveLength(1);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
});

test("reservation storage failure survives SPA remount and locks endpoint effects", async ({
  page,
}) => {
  await failReconciliationStorageAfter(page, 0);
  const { messages, uploads } = await openTerminalWithMockSocket(page);

  await page.locator('input[type="file"]').setInputFiles({
    name: "blocked-before.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("blocked"),
  });
  await expect(page.getByTestId("upload-reconciliation-fault")).toBeVisible();
  await expect(page.getByTestId("upload-reconciliation")).toContainText("blocked-before.txt");
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    0,
  );
  expect(uploads).toHaveLength(0);

  await page.locator('[aria-label^="Back"]').first().click();
  await page.goForward();
  await expect(page.getByTestId("upload-reconciliation-fault")).toBeVisible();
  await expect(page.getByTestId("upload-reconciliation")).toContainText("blocked-before.txt");
  await page.locator('input[type="file"]').setInputFiles({
    name: "also-blocked.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("blocked again"),
  });
  await page.waitForTimeout(100);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    0,
  );

  await restoreReconciliationStorage(page);
  await page.getByRole("button", { name: "Dismiss blocked-before.txt after checking" }).click();
  await page.getByRole("button", { name: "Dismiss also-blocked.txt after checking" }).click();
  await expect(page.getByTestId("upload-reconciliation")).toHaveCount(0);
  await page.locator('input[type="file"]').setInputFiles({
    name: "after-recovery.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("allowed"),
  });
  await expect.poll(() => uploads).toHaveLength(1);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
});

test("pre-final storage failure cancels before publication and keeps the upload locked", async ({
  page,
}) => {
  await failReconciliationStorageAfter(page, 1);
  const { messages, uploads } = await openTerminalWithMockSocket(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "blocked-final.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("must not publish"),
  });

  await expect(page.getByTestId("upload-reconciliation-fault")).toBeVisible();
  await expect(page.getByTestId("upload-reconciliation")).toContainText(
    "final frame was not dispatched",
  );
  await expect
    .poll(() => jsonMessages(messages).filter((message) => message?.type === "upload_start"))
    .toHaveLength(1);
  await expect
    .poll(() => jsonMessages(messages).filter((message) => message?.type === "upload_cancel"))
    .toHaveLength(1);
  expect(uploads).toHaveLength(0);

  await page.locator('input[type="file"]').setInputFiles({
    name: "locked-too.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("still locked"),
  });
  await page.waitForTimeout(100);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  expect(uploads).toHaveLength(0);
});

test("a concurrent storage fault permanently blocks every older stalled reservation", async ({
  page,
}) => {
  await stallFirstUploadHash(page);
  await failReconciliationStorageAfter(page, 2);
  const { messages, uploads } = await openTerminalWithMockSocket(page);
  const input = page.locator('input[type="file"]');

  await input.setInputFiles({
    name: "stalled-a.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("stalled A"),
  });
  await expect(page.getByTestId("upload-reconciliation")).toContainText("stalled-a.txt");
  await input.setInputFiles({
    name: "faulting-b.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("faulting B"),
  });
  await expect(page.getByTestId("upload-reconciliation-fault")).toBeVisible();
  await expect(page.getByTestId("upload-reconciliation")).toContainText("faulting-b.txt");
  await expect
    .poll(() => jsonMessages(messages).filter((message) => message?.type === "upload_start"))
    .toHaveLength(1);
  expect(uploads).toHaveLength(0);

  await restoreReconciliationStorage(page);
  await expect(page.getByTestId("upload-reconciliation-fault")).toBeVisible();

  await input.setInputFiles({
    name: "locked-c.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("locked C"),
  });
  await page.waitForTimeout(100);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  await page.getByRole("button", { name: "Dismiss faulting-b.txt after checking" }).click();
  await expect(page.getByTestId("upload-reconciliation-fault")).toHaveCount(0);
  await page.evaluate(() => {
    (
      window as unknown as { __spawnReleaseFirstUploadHash: () => void }
    ).__spawnReleaseFirstUploadHash();
  });
  await page.waitForTimeout(150);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  expect(uploads).toHaveLength(0);

  await input.setInputFiles({
    name: "safe-d.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("safe D"),
  });
  await expect.poll(() => uploads).toHaveLength(1);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    2,
  );
});

test("dual storage and history failure stays typed and updates overlapping consumers", async ({
  page,
}) => {
  await failReconciliationStorageAfter(page, 0);
  await failReconciliationHistoryFallback(page);
  const { messages, uploads } = await openTerminalWithMockSocket(page);
  await page.evaluate((sessionId) => {
    const probe = document.createElement("div");
    probe.dataset.testid = "upload-reconciliation-overlap-probe";
    document.body.append(probe);
    const sync = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.sessionId !== sessionId) return;
      const runtime = (
        globalThis as typeof globalThis & {
          __spawnUploadReconciliationRuntime?: {
            memory: Map<string, Array<{ fileName: string }>>;
            faults: Map<string, string>;
          };
        }
      ).__spawnUploadReconciliationRuntime;
      probe.textContent = `${runtime?.faults.get(sessionId) ?? ""}|${
        runtime?.memory
          .get(sessionId)
          ?.map((record) => record.fileName)
          .join(",") ?? ""
      }`;
    };
    window.addEventListener("spawn:upload-reconciliation", sync);
  }, SESSION_ID);

  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "dual-failure.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("never dispatched"),
    });
  await expect(page.getByTestId("upload-reconciliation-fault")).toBeVisible();
  await expect(page.getByTestId("upload-reconciliation")).toContainText("dual-failure.txt");
  await expect(page.getByTestId("upload-reconciliation-overlap-probe")).toContainText(
    "Upload reconciliation storage is unavailable.|dual-failure.txt",
  );
  await expect(
    page.getByText("Upload reconciliation storage is unavailable.").first(),
  ).toBeVisible();
  expect(await page.getByText(/DataCloneError|test history failure/).count()).toBe(0);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    0,
  );
  expect(uploads).toHaveLength(0);

  await restoreReconciliationStorage(page);
  await page.evaluate(() => {
    (
      window as unknown as { __spawnRestoreReconciliationHistory: () => void }
    ).__spawnRestoreReconciliationHistory();
  });
  await page.getByRole("button", { name: "Dismiss dual-failure.txt after checking" }).click();
  await expect(page.getByTestId("upload-reconciliation")).toHaveCount(0);
  await expect(page.getByTestId("upload-reconciliation-overlap-probe")).toHaveText("|");
});

test("post-final storage failure preserves one ambiguity and blocks retry across remount", async ({
  page,
}) => {
  await failReconciliationStorageAfter(page, 2);
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    uploadFinalAction: "hold",
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "published-once.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("published once"),
  });
  await expect.poll(() => uploads).toHaveLength(1);
  await page.evaluate(() => {
    (
      window as unknown as { __spawnRtcTest: { replaceRtcGeneration: () => void } }
    ).__spawnRtcTest.replaceRtcGeneration();
  });
  await expect(page.getByTestId("upload-reconciliation-fault")).toBeVisible();
  await expect(page.getByTestId("upload-reconciliation")).toContainText("published-once.txt");
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  expect(uploads).toHaveLength(1);

  await page.locator('[aria-label^="Back"]').first().click();
  await page.goForward();
  await expect(page.getByTestId("upload-reconciliation-fault")).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: "must-not-retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("no retry"),
  });
  await page.waitForTimeout(100);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  expect(uploads).toHaveLength(1);

  await restoreReconciliationStorage(page);
  await page.getByRole("button", { name: "Dismiss published-once.txt after checking" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "new-after-check.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("new effect"),
  });
  await expect
    .poll(() => jsonMessages(messages).filter((message) => message?.type === "upload_start"))
    .toHaveLength(2);
});

test("multi-chunk upload waits for real bufferedAmount drain", async ({ page }) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    stallUploadBackpressure: true,
  });
  const bytes = Buffer.alloc(100_000, 0x5a);

  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "large.bin", mimeType: "application/octet-stream", buffer: bytes });
  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "upload_start"))
    .toMatchObject({ name: "large.bin", total_bytes: bytes.length, chunks: 3 });
  await page.waitForTimeout(100);
  expect(uploads).toHaveLength(0);

  await page.evaluate(() => {
    (
      window as unknown as { __spawnRtcTest: { releaseUploadBackpressure: () => void } }
    ).__spawnRtcTest.releaseUploadBackpressure();
  });
  await expect.poll(() => uploads.at(-1)?.bytes.length).toBe(bytes.length);
  expect(uploads.at(-1)?.bytes.equals(bytes)).toBe(true);
});

test("a file dragged over the terminal raises the drop hint", async ({ page }) => {
  // The sign that the terminal will take what someone is holding, which is
  // the whole of the gesture until they let go. What a drag says about itself
  // mid-flight differs by engine — `files` is empty until the drop in Chrome,
  // and WebKit can hand back an `items` list nothing may be read from — so
  // `hasFileTransfer` asks all three, `types` included.
  await openTerminalWithMockSocket(page);
  const terminal = page.getByLabel("Session terminal");
  await terminal.evaluate((node) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
    node.dispatchEvent(
      new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });
  await expect(terminal.getByText("Drop images into the prompt")).toBeVisible();
});

test("removing an uploading attachment aborts it and sends upload_cancel", async ({ page }) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    stallUploadBackpressure: true,
  });
  await page.getByLabel("Session terminal").evaluate((terminal) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(100_000).fill(0x31)], "cancel.png", { type: "image/png" }),
    );
    terminal.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });

  await expect(page.getByRole("button", { name: "Remove cancel.png" })).toBeVisible();
  await expect
    .poll(() => jsonMessages(messages).some((message) => message?.type === "upload_start"))
    .toBe(true);
  await page.getByRole("button", { name: "Remove cancel.png" }).click();
  await expect(page.getByRole("button", { name: "Remove cancel.png" })).toHaveCount(0);
  await expect
    .poll(() => jsonMessages(messages).some((message) => message?.type === "upload_cancel"))
    .toBe(true);
  await page.evaluate(() => {
    (
      window as unknown as { __spawnRtcTest: { releaseUploadBackpressure: () => void } }
    ).__spawnRtcTest.releaseUploadBackpressure();
  });
  await page.waitForTimeout(100);
  expect(uploads).toHaveLength(0);
  await page.clock.install();
  await page.clock.fastForward(3_500);
  await expect(page.getByTestId("upload-reconciliation")).toHaveCount(0);
});

test("a gated final read fails closed: the safety lock ignores queued completion", async ({
  page,
}) => {
  // In-flight attachments no longer offer removal (the chip appears once an
  // attachment settles); the fail-closed story moved into the reconciliation
  // record itself. What must still hold: while the final frame has not been
  // dispatched, a spoofed/queued completion cannot fake success, and the
  // surfaced record never contradicts what actually reached the wire.
  await stallFinalUploadRead(page);
  const { messages, uploads } = await openTerminalWithMockSocket(page);
  await page.getByLabel("Session terminal").evaluate((terminal) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["gated final read"], "gated-remove.png", { type: "image/png" }));
    terminal.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });

  await expect
    .poll(() => jsonMessages(messages).filter((message) => message?.type === "upload_start"))
    .toHaveLength(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __spawnFinalUploadReadGate: { started: () => boolean };
          }
        ).__spawnFinalUploadReadGate.started(),
      ),
    )
    .toBe(true);

  // The stuck dispatch surfaces as the reserved-state safety lock, and a
  // completion queued while the frame is un-dispatched changes nothing.
  await expect(page.getByTestId("upload-reconciliation")).toContainText(
    "final frame was not dispatched",
  );
  expect(
    await page.evaluate(() =>
      (
        window as unknown as {
          __spawnRtcTest: { queueActiveUploadCompletion: () => boolean };
        }
      ).__spawnRtcTest.queueActiveUploadCompletion(),
    ),
  ).toBe(true);
  await page.waitForTimeout(100);
  expect(uploads).toHaveLength(0);
  await expect(page.getByTestId("upload-reconciliation")).toContainText(
    "final frame was not dispatched",
  );

  // Releasing the read lets the genuine dispatch finish: exactly one upload
  // lands, nothing retried, and the record resolves instead of lying on.
  await page.evaluate(() => {
    (
      window as unknown as { __spawnFinalUploadReadGate: { release: () => void } }
    ).__spawnFinalUploadReadGate.release();
  });
  await expect.poll(() => uploads).toHaveLength(1);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  await expect(page.getByTestId("upload-reconciliation")).toHaveCount(0);
});

test("a held final acknowledgement surfaces outcome_unknown and never retries", async ({
  page,
}) => {
  // Post-publication attachments no longer offer removal; the outcome_unknown
  // story is the reconciliation record itself. What must still hold: one
  // dispatch, no automatic retry, honest "may have been published" copy, and
  // a record durable across transient upload statuses.
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    uploadFinalAction: "hold",
  });
  await page.getByLabel("Session terminal").evaluate((terminal) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["published"], "maybe.png", { type: "image/png" }));
    terminal.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });

  await expect.poll(() => uploads).toHaveLength(1);
  await expect(page.getByTestId("upload-reconciliation")).toContainText(
    "Check the endpoint destination before retrying",
  );
  await page.clock.install();
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  expect(uploads).toHaveLength(1);

  await page.clock.fastForward(3_500);
  await expect(page.getByTestId("upload-reconciliation")).toContainText(
    "Check the endpoint destination before retrying",
  );

  // A later ordinary status may come and go without replacing the durable
  // reconciliation record.
  await page.locator('input[type="file"]').setInputFiles({
    name: "too-large.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
  });
  await expect(page.getByText(/larger than 20 MB/i)).toBeVisible();
  await page.clock.fastForward(3_500);
  await expect(page.getByText(/larger than 20 MB/i)).toHaveCount(0);
  await expect(page.getByTestId("upload-reconciliation")).toContainText("maybe.png");

  // Navigation fully unmounts this terminal; the session-scoped record
  // restores on the next component instance.
  await page.goto("/download");
  await page.goto(`/sessions/${SESSION_ID}`);
  await expect(page.getByLabel("Session terminal")).toBeVisible();
  await expect(page.getByTestId("upload-reconciliation")).toContainText("maybe.png");
  await page.getByRole("button", { name: "Check in terminal" }).click();
  await expect(
    page.getByTestId("terminal-live-host").locator(".xterm-helper-textarea"),
  ).toBeFocused();
  await page.getByRole("button", { name: "Dismiss maybe.png after checking" }).click();
  await expect(page.getByTestId("upload-reconciliation")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Session terminal")).toBeVisible();
  await expect(page.getByTestId("upload-reconciliation")).toHaveCount(0);

  // A late acknowledgement for the already-dismissed upload must not
  // resurrect the record: the human said "I checked", and that stands.
  await page.evaluate(() => {
    (
      window as unknown as {
        __spawnRtcTest: { releaseHeldUploadCompletion: () => void };
      }
    ).__spawnRtcTest.releaseHeldUploadCompletion();
  });
  await page.waitForTimeout(200);
  await expect(page.getByTestId("upload-reconciliation")).toHaveCount(0);
});

test("unmount after final dispatch persists reconciliation for the next terminal instance", async ({
  page,
}) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    uploadFinalAction: "hold",
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "navigate.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("published"),
  });
  await expect.poll(() => uploads).toHaveLength(1);
  await expect(page.getByTestId("upload-reconciliation")).toContainText("navigate.bin");

  await page.goto("/download");
  await page.goto(`/sessions/${SESSION_ID}`);
  await expect(page.getByLabel("Session terminal")).toBeVisible();
  await expect(page.getByTestId("upload-reconciliation")).toContainText("navigate.bin");
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  expect(uploads).toHaveLength(1);
});

test("RTC generation replacement is definitive before final dispatch", async ({ page }) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    stallUploadBackpressure: true,
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "before.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(100_000),
  });
  await expect
    .poll(() => jsonMessages(messages).some((message) => message?.type === "upload_start"))
    .toBe(true);

  await page.evaluate(() => {
    (
      window as unknown as { __spawnRtcTest: { replaceRtcGeneration: () => void } }
    ).__spawnRtcTest.replaceRtcGeneration();
  });
  await expect(page.getByText("Direct session upload channel closed.")).toBeVisible();
  expect(uploads).toHaveLength(0);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
});

test("RTC generation replacement during the final Blob read cannot dispatch", async ({ page }) => {
  await stallFinalUploadRead(page);
  const { messages, uploads } = await openTerminalWithMockSocket(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "gated-generation.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("gated generation"),
  });
  await expect
    .poll(() => jsonMessages(messages).filter((message) => message?.type === "upload_start"))
    .toHaveLength(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __spawnFinalUploadReadGate: { started: () => boolean };
          }
        ).__spawnFinalUploadReadGate.started(),
      ),
    )
    .toBe(true);

  await page.evaluate(() => {
    (
      window as unknown as { __spawnRtcTest: { replaceRtcGeneration: () => void } }
    ).__spawnRtcTest.replaceRtcGeneration();
    (
      window as unknown as { __spawnFinalUploadReadGate: { release: () => void } }
    ).__spawnFinalUploadReadGate.release();
  });
  await expect(page.getByText("Direct session upload channel closed.")).toBeVisible();
  await page.waitForTimeout(100);
  expect(uploads).toHaveLength(0);
  await expect(page.getByTestId("upload-reconciliation")).toHaveCount(0);
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
});

test("RTC generation replacement after final dispatch is outcome_unknown", async ({ page }) => {
  const { messages, uploads } = await openTerminalWithMockSocket(page, {
    uploadFinalAction: "hold",
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "after.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("published"),
  });
  await expect.poll(() => uploads).toHaveLength(1);

  await page.evaluate(() => {
    (
      window as unknown as { __spawnRtcTest: { replaceRtcGeneration: () => void } }
    ).__spawnRtcTest.replaceRtcGeneration();
  });
  await expect(page.getByTestId("upload-reconciliation")).toContainText("after.bin");
  expect(jsonMessages(messages).filter((message) => message?.type === "upload_start")).toHaveLength(
    1,
  );
  expect(uploads).toHaveLength(1);
});

test("spawn.v3 keeps keystrokes off the websocket until the DataChannel opens", async ({
  page,
}) => {
  const { messages } = await openTerminalWithMockSocket(page, { noChannels: true });

  // Viewport state belongs to spawn.ctl and must not be observable by
  // the application server. This mock deliberately never opens DataChannels.
  await page.waitForTimeout(300);
  expect(jsonMessages(messages).some((message) => message?.type === "resize")).toBe(false);
  await expect
    .poll(() => jsonMessages(messages).find((message) => message?.type === "rtc.offer"))
    .toMatchObject({
      type: "rtc.offer",
      binding_nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
    });

  await page.getByLabel("Session terminal").click();
  await page.keyboard.type("secret input");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  // No DataChannel exists in the mock, so input is queued client-side; the
  // relay path must never carry it.
  expect(binaryText(messages)).toBe("");
});

test("spawn.v3 holds endpoint effects until the daemon readiness event", async ({ page }) => {
  const { messages } = await openTerminalWithMockSocket(page, { noReady: true });

  await page.waitForFunction(() => {
    return (
      window as unknown as {
        __spawnRtcTest?: { ptyReady: () => boolean };
      }
    ).__spawnRtcTest?.ptyReady();
  });
  await page.getByLabel("Session terminal").click();
  await page.keyboard.type("queued until ready");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);

  expect(binaryText(messages)).toBe("");
  expect(jsonMessages(messages).some((message) => message?.kind === "request")).toBe(false);
});

test("terminal reconnect restores a fresh terminal history snapshot", async ({ page }) => {
  const { sockets } = await openTerminalWithMockSocket(page, { reconnect: true });

  await expect(liveTerminalRows(page)).toContainText("RED");
  await expect.poll(() => sockets.length).toBeGreaterThanOrEqual(2);
  await expect(liveTerminalRows(page)).toContainText("after reconnect");
});

// Same product gap as session-switcher.spec.ts: SessionView offers no way to
// reach another session, so there is no client-side transition to scope
// callbacks across. Kept executable so the switcher's implementation handoff
// picks this contract up too.
test.fixme("previous-session callbacks remain scoped to the previous terminal", async ({
  page,
}) => {
  const messages: Array<string | Buffer> = [];
  await installSessionRtcMock(page, messages, {
    history: "FIRST-AGENT\n",
    secondHistory: "SECOND-AGENT\n",
  });
  await mockApp(page, {
    sessions: [session(), session({ id: SESSION_B_ID, name: "second" })],
    workspaces: [
      workspace({
        layout: {
          version: 3,
          tiles: [
            { session_id: SESSION_ID, x: 0, y: 0, w: 12, h: 24 },
            { session_id: SESSION_B_ID, x: 12, y: 0, w: 12, h: 24 },
          ],
        },
      }),
    ],
  });
  const sockets = new Map<string, WebSocketRoute>();
  await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
    const sessionId = new URL(ws.url()).searchParams.get("session_id") ?? "unknown";
    sockets.set(sessionId, ws);
    ws.onMessage((message) => {
      messages.push(message);
      handleSessionRtcSignal(ws, message);
    });
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

  await page.goto(`/sessions/${SESSION_ID}`);
  await expect(liveTerminalRows(page)).toContainText("FIRST-AGENT");
  expect(sockets.get(SESSION_ID)).toBeDefined();

  await page.getByRole("link", { name: /second/i }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${SESSION_B_ID}$`));
  const secondSessionRows = page
    .locator('[data-testid="terminal-live-host"]:visible .xterm-rows')
    .last();
  await expect(secondSessionRows).toContainText("SECOND-AGENT");
  await sendPty(page, "STALE-FIRST-CALLBACK\n", 0);
  await page.waitForTimeout(100);

  await expect(secondSessionRows).not.toContainText("STALE-FIRST-CALLBACK");
  await expect(page.getByText("Another session has control · 222x88 · 9 viewers")).toBeHidden();
});

test("worker replay streams render exactly with geometry markers", async ({ page }) => {
  // Worker-backed agents ship history/snapshots as exact terminal byte
  // streams of geometry-tagged, self-contained chunks (CSI 8 ; rows ; cols t
  // + checkpoint repaint + output). The client must render them without the
  // transcript CR/LF reformatting — the lone-\r overwrite below would
  // split into two lines under it. The LIVE terminal seeds from the final
  // chunk alone and is never resized through historical geometries; the
  // overlay renders every chunk at its own geometry.
  const history =
    "\x1b[8;30;80t" +
    `${Array.from({ length: 40 }, (_, i) => `deep-${String(i).padStart(3, "0")}`).join("\r\n")}\r\n` +
    "progress:AAAA\rprogress:BBBB\r\n" +
    "\x1b[8;30;100t" +
    "repainted-screen-line\r\nprogress:BBBB\r\ntail-at-current-size\r\n$ ";
  // Legacy worker: the overlay fetches a capture per open; the mock answers
  // with the same geometry-tagged stream.
  await openTerminalWithMockSocket(page, { history, autoSnapshot: true });

  await expect(liveTerminalRows(page)).toContainText("tail-at-current-size");
  await expect(liveTerminalRows(page)).toContainText("progress:BBBB");
  await expect(liveTerminalRows(page)).not.toContainText("AAAA");
  // Last-chunk-only seeding: old-geometry content stays out of the live
  // terminal buffer entirely.
  await expect(liveTerminalRows(page)).not.toContainText("deep-039");
});

test("terminal wheel in alternate screen becomes arrow keys, not a history fetch", async ({
  page,
}) => {
  const { messages } = await openTerminalWithMockSocket(page, {
    history: `\x1b[?1049h${longHistory(160).replaceAll("\n", "\r\n")}ALT SCREEN\r\n`,
  });

  await expect(liveTerminalRows(page)).toContainText("ALT SCREEN");

  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(250);

  // Native alt-buffer handling (xterm's alternate-scroll, iTerm2's default
  // too): the wheel drives the APP via arrow keys — scrolling works in
  // less/vim without mouse mode — and nothing fetches or reveals history.
  expect(jsonMessages(messages).some((message) => message?.type === "snapshot")).toBe(false);
  expect(binaryText(messages)).toContain("\x1b[A");
  expect(jsonMessages(messages).some((message) => message?.type === "scroll")).toBe(false);
  await expect(liveTerminalRows(page)).toContainText("ALT SCREEN");
});

test.describe("mobile terminal touch", () => {
  const mobile = devices["iPhone 14 Pro"];
  test.use({
    deviceScaleFactor: mobile.deviceScaleFactor,
    hasTouch: mobile.hasTouch,
    isMobile: mobile.isMobile,
    userAgent: mobile.userAgent,
    viewport: mobile.viewport,
  });

  test("touch scrolls native history, stays live, and returns to the edge", async ({ page }) => {
    await openTerminalWithMockSocket(page, {
      history: longHistory(240),
    });
    await expect(page.getByLabel("Session terminal")).toBeVisible();
    // A flick can only reveal scrollback that exists: wait for the replayed
    // history to land in the live terminal before gesturing.
    await expect(liveTerminalRows(page)).toContainText("history-");

    // Drag down: the live buffer itself scrolls up into history.
    await dragTouchInTerminal(page, 0.3, 0.85);
    await expect
      .poll(async () => {
        const metrics = await liveViewportMetrics(page);
        return metrics.maxTop > 0 && metrics.scrollTop < metrics.maxTop - 1;
      })
      .toBe(true);

    // Live output while scrolled back lands once and does not yank the view.
    await sendPty(page, "\x1b[2A\rMOBILE-LIVE-WHILE-SCROLLED");
    await page.waitForTimeout(200);
    const scrolled = await liveViewportMetrics(page);
    expect(scrolled.scrollTop < scrolled.maxTop - 1).toBe(true);

    // Bounded upward gestures walk back to the live edge.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const metrics = await liveViewportMetrics(page);
      if (metrics.scrollTop >= metrics.maxTop - 1) break;
      await dragTouchInTerminal(page, 0.9, 0.1);
      await page.waitForTimeout(150);
    }
    await expect
      .poll(async () => {
        const metrics = await liveViewportMetrics(page);
        return metrics.scrollTop >= metrics.maxTop - 1;
      })
      .toBe(true);
    await expect
      .poll(async () => {
        const text = await liveTerminalRows(page).innerText();
        return text.split("MOBILE-LIVE-WHILE-SCROLLED").length - 1;
      })
      .toBe(1);
  });

  // A pane is terminal from edge to edge bar its header, so a terminal that
  // swallows the drags it cannot use leaves the stack unscrollable by finger —
  // which is every stack whose panes run full-screen TUIs.
  test("a drag the terminal cannot use scrolls the pane stack instead", async ({ page }) => {
    const messages: Array<string | Buffer> = [];
    await installSessionRtcMock(page, messages, {
      // The alternate buffer has no scrollback of its own to give.
      history: "\x1b[?1049hALT-SCREEN-ALPHA\r\n",
      secondHistory: "\x1b[?1049hALT-SCREEN-BETA\r\n",
    });
    await mockApp(page, {
      sessions: [session(), session({ id: SESSION_B_ID, name: "beta" })],
      workspaces: [
        workspace({
          layout: {
            version: 3,
            tiles: [
              { session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 12 },
              { session_id: SESSION_B_ID, x: 0, y: 12, w: 24, h: 12 },
            ],
          },
        }),
      ],
    });
    await page.routeWebSocket(/\/ws\/browser/, async (ws) => {
      ws.onMessage((message) => {
        messages.push(message);
        handleSessionRtcSignal(ws, message);
      });
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
    const stack = page.locator("[data-pane-stack]");
    // Either session may answer first; both panes are alternate-buffer.
    await expect(liveTerminalRows(page).first()).toContainText(/ALT-SCREEN-(ALPHA|BETA)/);
    // Two panes at 55dvh apiece: the stack is taller than the viewport.
    await expect
      .poll(() => stack.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(0);
    expect(await stack.evaluate((el) => el.scrollTop)).toBe(0);

    await dragTouchInTerminal(page, 0.8, 0.2, liveTerminal(page).first());

    await expect.poll(() => stack.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  // A card's reading height is a floor, not a size: a stack short of the fold
  // grows its panes to spend the whole column. A lone pane perched above a
  // void wastes half the phone and leaves the void swallowing scroll gestures
  // it cannot answer.
  test("a lone pane fills the stack instead of perching above a void", async ({ page }) => {
    await installSessionRtcMock(page, [], { history: "ready\r\n$ " });
    await mockApp(page, {
      sessions: [session()],
      workspaces: [
        workspace({
          layout: { version: 3, tiles: [{ session_id: SESSION_ID, x: 0, y: 0, w: 24, h: 24 }] },
        }),
      ],
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
    await expect(liveTerminalRows(page)).toContainText("ready");

    const stack = page.locator("[data-pane-stack]");
    const card = stack.locator("> div").first();
    const stackBox = await stack.boundingBox();
    const cardBox = await card.boundingBox();
    if (!stackBox || !cardBox) throw new Error("stack geometry unavailable");
    // The card's bottom edge reaches the stack's, give or take the stack's
    // own padding — no dead canvas below.
    expect(stackBox.y + stackBox.height - (cardBox.y + cardBox.height)).toBeLessThan(16);
    // And nothing overflowed doing it: a single card is not what scrolls.
    expect(await stack.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThan(2);
  });
});

test("connection chip opens a details popover", async ({ page }) => {
  await openTerminalWithMockSocket(page);

  const chip = page.getByRole("button", { name: /Connection details/ });
  await expect(chip).toHaveAttribute(
    "title",
    /terminal bytes and history are endpoint-to-endpoint/,
  );
  await chip.click();

  await expect(page.getByText("Path", { exact: true })).toBeVisible();
  await expect(page.getByText("Round trip", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/server receives signaling and disclosed activity only/),
  ).toBeVisible();
});

// Terminal emulation fidelity in the real renderer. Grid-level behavior is
// covered by tools/term-conformance/; these assert the browser-visible side
// of the same guarantees (shared config in xterm-config.mjs).

test("emoji occupy two cells (Unicode 11 width tables)", async ({ page }) => {
  await openTerminalWithMockSocket(page, { history: "\u{1F600}X\r\n" });
  const rows = liveTerminalRows(page);
  await expect(rows).toContainText("X");

  const widths = await rows.evaluate((rowsEl) => {
    const spans = Array.from(rowsEl.querySelectorAll("span"));
    const width = (text: string) =>
      spans.find((s) => s.textContent === text)?.getBoundingClientRect().width ?? 0;
    return { emoji: width("\u{1F600}"), x: width("X") };
  });
  expect(widths.x).toBeGreaterThan(0);
  // Under xterm's built-in Unicode 6 tables the emoji is one cell wide and
  // glyphs render overlapped; Unicode 11 gives it a two-cell lead.
  expect(widths.emoji / widths.x).toBeCloseTo(2, 1);
});

test("OSC 8 hyperlinks render and open without a JavaScript warning", async ({ page }) => {
  await openTerminalWithMockSocket(page, {
    history: "\x1b]8;;https://example.com\x1b\\LINKTEXT\x1b]8;;\x1b\\ plain\r\n",
  });
  const rows = liveTerminalRows(page);
  await expect(rows).toContainText("LINKTEXT");
  await expect(rows).not.toContainText("example.com");

  const linkSpan = rows.locator("span", { hasText: "LINKTEXT" }).first();
  // xterm discovers/decorates links after the row itself paints. Poll the
  // computed style so parallel renderer pressure cannot sample the brief
  // undecorated frame while preserving the exact underline requirement.
  await expect
    .poll(() => linkSpan.evaluate((node) => getComputedStyle(node).textDecorationLine))
    .toContain("underline");
  const plainDecoration = await rows
    .locator("span", { hasText: "plain" })
    .first()
    .evaluate((node) => getComputedStyle(node).textDecorationLine);
  expect(plainDecoration).not.toContain("underline");

  await page.evaluate(() => {
    const openedUrls: string[] = [];
    Object.assign(globalThis, { __terminalOpenedUrls: openedUrls });
    window.open = (() => {
      const openedWindow = { opener: window, location: {} };
      Object.defineProperty(openedWindow.location, "href", {
        set: (url: string) => openedUrls.push(url),
      });
      return openedWindow as unknown as Window;
    }) as typeof window.open;
  });
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await linkSpan.click();

  expect(dialogs).toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as typeof globalThis & { __terminalOpenedUrls?: string[] })
            .__terminalOpenedUrls ?? [],
      ),
    )
    .toEqual(["https://example.com"]);
});

test("DECSCUSR switches the rendered cursor shape", async ({ page }) => {
  await openTerminalWithMockSocket(page, { history: "ready\r\n" });
  await page.getByLabel("Session terminal").click();

  await sendPty(page, "\x1b[6 q");
  await expect(page.getByTestId("terminal-live-host").locator(".xterm-cursor-bar")).toHaveCount(1);

  await sendPty(page, "\x1b[4 q");
  await expect(
    page.getByTestId("terminal-live-host").locator(".xterm-cursor-underline"),
  ).toHaveCount(1);

  await sendPty(page, "\x1b[2 q");
  await expect(page.getByTestId("terminal-live-host").locator(".xterm-cursor-bar")).toHaveCount(0);
  await expect(
    page.getByTestId("terminal-live-host").locator(".xterm-cursor-underline"),
  ).toHaveCount(0);
});

test.describe("OSC 52 clipboard", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("session writes to the system clipboard through OSC 52", async ({ page }) => {
    await openTerminalWithMockSocket(page, { history: "ready\r\n" });
    await page.getByLabel("Session terminal").click();

    const payload = Buffer.from("hello clipboard", "utf8").toString("base64");
    await sendPty(page, `\x1b]52;c;${payload}\x07`);

    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText().catch(() => "")))
      .toBe("hello clipboard");
  });
});

test("a replay longer than one daemon chunk still seeds the terminal", async ({ page }) => {
  // The daemon frames a replay in 16 KiB chunks. A pane whose history does not
  // fit in one — a Codex session that scrolls inline, unlike a fullscreen TUI,
  // which commits no history — must assemble every chunk and open. A client
  // that assumed the chunk size discarded the reply in silence and aborted at
  // its connect timer, forever (2026-09-05).
  // 19 bytes a line, so line 860 straddles the first chunk boundary at 16,356.
  const lines = Array.from(
    { length: 3000 },
    (_, index) => `history line ${String(index).padStart(4, "0")}\r\n`,
  ).join("");
  const history = `\x1b[8;36;83t\x1b_sp:h1\x1b\\${lines}\x1b[8;36;83tlong-history-ready\r\n$ `;
  expect(Buffer.byteLength(history)).toBeGreaterThan(3 * (16 * 1024 - 28));
  const { messages } = await openTerminalWithMockSocket(page, {
    history,
    historyEpoch: "1788604290762026535",
    historyOffset: 74053,
  });
  await expect(liveTerminalRows(page)).toContainText("long-history-ready");
  await page.getByLabel("Session terminal").click();
  await page.keyboard.type("ok");
  await expect.poll(() => binaryText(messages)).toContain("ok");
  // The first chunk is the top of the scrollback, so the history arrived in
  // order and not merely in full.
  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -1_000_000);
  await expect(liveTerminalRows(page)).toContainText("history line 0000");
});

test("a reconnect reseed keeps its history when the previous screen set a scroll region", async ({
  page,
}) => {
  // The first screen's tail sets DECSTBM rows 2–5, as an agent TUI does.
  // 2J/3J do not undo it, so without restoring the margins the reseed's
  // history scrolls inside those four rows and never reaches scrollback (#58).
  const seed = (lines: string[], screen: string) =>
    `\x1b[8;36;83t\x1b_sp:h1\x1b\\${lines.map((line) => `${line}\r\n`).join("")}\x1b[8;36;83t${screen}`;
  const { sockets } = await openTerminalWithMockSocket(page, {
    reconnect: true,
    history: seed(["old 1", "old 2"], "\x1b[1;1Hbefore-reconnect\x1b[2;5r"),
    secondHistory: seed(
      Array.from({ length: 60 }, (_, index) => `new ${String(index + 1).padStart(2, "0")}`),
      "\x1b[1;1Hafter-reconnect",
    ),
  });
  await expect(liveTerminalRows(page)).toContainText("before-reconnect");
  await expect.poll(() => sockets.length).toBeGreaterThanOrEqual(2);
  await expect(liveTerminalRows(page)).toContainText("after-reconnect");
  await liveTerminal(page).hover();
  await page.mouse.wheel(0, -1_000_000);
  await expect(liveTerminalRows(page)).toContainText("new 01");
  await expect(liveTerminalRows(page)).not.toContainText("old 1");
});
