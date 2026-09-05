import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

describe("offline terminal worker", () => {
  test("is a self-contained CSP-restricted document", () => {
    expect(TERMINAL_WORKER_HTML).toContain("default-src 'none'");
    expect(TERMINAL_WORKER_HTML).toContain('<base href="https://spawn.local/">');
    expect(TERMINAL_WORKER_HTML).not.toMatch(/<script[^>]+src=/i);
    expect(TERMINAL_WORKER_HTML).not.toMatch(/<link[^>]+href=/i);
  });

  test("forwards plain-text and OSC 8 xterm links through the native bridge", () => {
    expect(TERMINAL_WORKER_HTML).toContain(
      'const forwardTerminalLink = (_event, uri) => api.post({ type: "link", url: uri })',
    );
    expect(TERMINAL_WORKER_HTML).toContain("linkHandler: { activate: forwardTerminalLink }");
    expect(TERMINAL_WORKER_HTML).toContain("new WebLinksAddon.WebLinksAddon(forwardTerminalLink)");
  });

  test("contains exact xterm parity configuration and addons", () => {
    expect(TERMINAL_WORKER_HTML).toContain("scrollback: 100_000");
    expect(TERMINAL_WORKER_HTML).toContain("lineHeight: 1.2");
    expect(TERMINAL_WORKER_HTML).toContain('terminal.unicode.activeVersion = "11"');
    expect(TERMINAL_WORKER_HTML).toContain("new FitAddon.FitAddon()");
    expect(TERMINAL_WORKER_HTML).toContain("new ClipboardAddon.ClipboardAddon");
    expect(TERMINAL_WORKER_HTML).toContain("new SerializeAddon.SerializeAddon()");
  });

  test("renders to the DOM so the system can select the output", () => {
    // WebGL draws glyphs into a canvas, which holds no text for iOS to select,
    // magnify, look up or copy. Real text nodes are what make a hold on terminal
    // output behave the way a hold on text behaves everywhere else on the phone.
    expect(TERMINAL_WORKER_HTML).not.toContain("new WebglAddon.WebglAddon()");
    expect(TERMINAL_WORKER_HTML).toContain('state.renderer = "dom"');
    expect(TERMINAL_WORKER_HTML).toContain(".xterm .xterm-rows *{user-select:text");
    // The helper textarea and cursor must not be selectable, or a hold would
    // catch those instead of the output underneath.
    expect(TERMINAL_WORKER_HTML).toContain(
      ".xterm .xterm-helpers,.xterm .xterm-helper-textarea,.xterm .xterm-cursor-layer{user-select:none",
    );
  });

  test("creates only exact ordered reliable protocol channels", () => {
    expect(TERMINAL_WORKER_HTML).toContain("Object.freeze({ ordered: true })");
    expect(TERMINAL_WORKER_HTML).toContain('createDataChannel("spawn.pty", CHANNEL_OPTIONS)');
    expect(TERMINAL_WORKER_HTML).toContain('createDataChannel("spawn.ctl", CHANNEL_OPTIONS)');
    expect(TERMINAL_WORKER_HTML).toContain('createDataChannel("spawn.host.ctl", CHANNEL_OPTIONS)');
    expect(TERMINAL_WORKER_HTML).not.toContain("maxPacketLifeTime");
    expect(TERMINAL_WORKER_HTML).not.toContain("maxRetransmits");
  });

  test("caps every native-to-worker PTY send at 16 KiB", () => {
    expect(TERMINAL_WORKER_HTML).toContain("const MAX_INPUT_BYTES = 16 * 1024");
    expect(TERMINAL_WORKER_HTML).toContain("offset += MAX_INPUT_BYTES");
  });

  test("ships the secure-context and loopback capability probe", () => {
    expect(TERMINAL_WORKER_HTML).toContain("globalThis.isSecureContext === true");
    expect(TERMINAL_WORKER_HTML).toContain('createDataChannel("spawn.probe", { ordered: true })');
    expect(TERMINAL_WORKER_HTML).toContain('type: "diagnostic"');
  });

  test("keeps PTY output inside the worker", () => {
    expect(TERMINAL_WORKER_HTML).toContain("state.term.write(takeWriteBatch()");
    expect(TERMINAL_WORKER_HTML).not.toContain('type: "output"');
  });

  test("uses one platform-correct native bridge listener without collapsing duplicates", () => {
    expect(TERMINAL_WORKER_HTML).toContain(
      "const bridgeTarget = /Android/i.test(navigator.userAgent) ? document : window",
    );
    expect(TERMINAL_WORKER_HTML).toContain('bridgeTarget.addEventListener("message", listener)');
    expect(TERMINAL_WORKER_HTML).not.toContain("lastRawAt");
  });

  test("rebuilds history cleanly and recovers both history and PTY gaps", () => {
    expect(TERMINAL_WORKER_HTML).toContain("session.bootstrapCount > 0 && alternate");
    expect(TERMINAL_WORKER_HTML).toContain(
      // The reseed clear: character sets, margins, origin mode and autowrap
      // restored before the screen and scrollback are wiped (#58).
      '"\\x1b[0m\\x1b(B\\x1b)B\\x0f\\x1b[r\\x1b[?6l\\x1b[?7h\\x1b[H\\x1b[2J\\x1b[3J",',
    );
    expect(TERMINAL_WORKER_HTML).toContain('message.event === "history_gap"');
    expect(TERMINAL_WORKER_HTML).toContain('message.event === "pty_gap"');
    expect(TERMINAL_WORKER_HTML).toContain("recoverFromGap(message.offset)");
  });

  test("retries only the pre-effect upload start exchange", () => {
    expect(TERMINAL_WORKER_HTML).toContain("const UPLOAD_START_ATTEMPTS = 3");
    expect(TERMINAL_WORKER_HTML).toContain("upload.startAttempts < UPLOAD_START_ATTEMPTS");
    expect(TERMINAL_WORKER_HTML).toContain("if (message.last) {");
    expect(TERMINAL_WORKER_HTML).toContain("upload.finalDispatched = true");
  });
});
