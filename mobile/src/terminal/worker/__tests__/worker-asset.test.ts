import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

describe("offline terminal worker", () => {
  test("is a self-contained CSP-restricted document", () => {
    expect(TERMINAL_WORKER_HTML).toContain("default-src 'none'");
    expect(TERMINAL_WORKER_HTML).toContain('<base href="https://spawn.local/">');
    expect(TERMINAL_WORKER_HTML).not.toMatch(/<script[^>]+src=/i);
    expect(TERMINAL_WORKER_HTML).not.toMatch(/<link[^>]+href=/i);
  });

  test("contains exact xterm parity configuration and addons", () => {
    expect(TERMINAL_WORKER_HTML).toContain("scrollback: 100_000");
    expect(TERMINAL_WORKER_HTML).toContain("lineHeight: 1.2");
    expect(TERMINAL_WORKER_HTML).toContain('terminal.unicode.activeVersion = "11"');
    expect(TERMINAL_WORKER_HTML).toContain("new FitAddon.FitAddon()");
    expect(TERMINAL_WORKER_HTML).toContain("new WebglAddon.WebglAddon()");
    expect(TERMINAL_WORKER_HTML).toContain("new ClipboardAddon.ClipboardAddon");
    expect(TERMINAL_WORKER_HTML).toContain("new SerializeAddon.SerializeAddon()");
  });

  test("creates only exact ordered reliable protocol channels", () => {
    expect(TERMINAL_WORKER_HTML).toContain("Object.freeze({ ordered: true })");
    expect(TERMINAL_WORKER_HTML).toContain('createDataChannel("spawn.pty", CHANNEL_OPTIONS)');
    expect(TERMINAL_WORKER_HTML).toContain('createDataChannel("spawn.ctl", CHANNEL_OPTIONS)');
    expect(TERMINAL_WORKER_HTML).toContain('createDataChannel("spawn.host.ctl", CHANNEL_OPTIONS)');
    expect(TERMINAL_WORKER_HTML).not.toContain("maxPacketLifeTime");
    expect(TERMINAL_WORKER_HTML).not.toContain("maxRetransmits");
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

  test("retries only the pre-effect upload start exchange", () => {
    expect(TERMINAL_WORKER_HTML).toContain("const UPLOAD_START_ATTEMPTS = 3");
    expect(TERMINAL_WORKER_HTML).toContain("upload.startAttempts < UPLOAD_START_ATTEMPTS");
    expect(TERMINAL_WORKER_HTML).toContain("if (message.last) {");
    expect(TERMINAL_WORKER_HTML).toContain("upload.finalDispatched = true");
  });
});
