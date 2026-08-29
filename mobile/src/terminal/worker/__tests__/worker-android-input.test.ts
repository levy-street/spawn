import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

const DELETE = "\u007f";

/**
 * The Android IME adapter runs inside the bundled WebView worker. Extracting
 * its pure edit translator lets these event shapes stay deterministic without
 * needing a particular phone, keyboard, or WebView version in Jest.
 */
function textareaEditSequence(): (previous: string, next: string) => string {
  const start = TERMINAL_WORKER_HTML.indexOf("  function textareaEditSequence(previous, next) {");
  const end = TERMINAL_WORKER_HTML.indexOf("\n  function installAndroidTextareaDiff(", start);
  if (start < 0 || end < start) throw new Error("Android textarea edit translation is missing.");

  const source = TERMINAL_WORKER_HTML.slice(start, end);
  return new Function("DELETE", `${source}\nreturn textareaEditSequence;`)(DELETE) as (
    previous: string,
    next: string,
  ) => string;
}

interface FakeCompositionHelper {
  _dataAlreadySent: string;
  _isComposing: boolean;
  _handleAnyTextareaChanges: jest.Mock;
}

interface FakeTerminal {
  _core: { _compositionHelper: FakeCompositionHelper };
  input: jest.Mock;
  textarea: { value: string };
}

function installAndroidTextareaDiff(): (terminal: FakeTerminal) => void {
  const start = TERMINAL_WORKER_HTML.indexOf("  function installAndroidTextareaDiff(terminal) {");
  const end = TERMINAL_WORKER_HTML.indexOf("\n  function configureTextarea(", start);
  if (start < 0 || end < start) throw new Error("Android textarea diff adapter is missing.");

  const source = TERMINAL_WORKER_HTML.slice(start, end);
  return new Function(
    "textareaEditSequence",
    "navigator",
    `${source}\nreturn installAndroidTextareaDiff;`,
  )(textareaEditSequence(), { userAgent: "Android WebView" }) as (terminal: FakeTerminal) => void;
}

function terminal(value: string): FakeTerminal {
  return {
    _core: {
      _compositionHelper: {
        _dataAlreadySent: "",
        _isComposing: false,
        _handleAnyTextareaChanges: jest.fn(),
      },
    },
    input: jest.fn(),
    textarea: { value },
  };
}

describe("Android terminal IME input", () => {
  test("sends only newly appended text", () => {
    expect(
      textareaEditSequence()("this is on the Android app", "this is on the Android app fyi"),
    ).toBe(" fyi");
  });

  test("rewinds and replaces an autocorrected word without replaying the prompt", () => {
    expect(textareaEditSequence()("this is a codex bigthis", "this is a codex bugthis")).toBe(
      `${DELETE.repeat(6)}ugthis`,
    );
  });

  test("handles corrections that change length and retain trailing text", () => {
    expect(textareaEditSequence()("please fx this", "please fix this")).toBe(
      `${DELETE.repeat(6)}ix this`,
    );
  });

  test("uses Unicode characters rather than UTF-16 units when rewinding", () => {
    expect(textareaEditSequence()("say 😺x", "say 😸x")).toBe(`${DELETE.repeat(2)}😸x`);
  });

  test("does nothing for an unchanged textarea", () => {
    expect(textareaEditSequence()("unchanged", "unchanged")).toBe("");
  });

  test("installs the adapter on the xterm instance", () => {
    expect(TERMINAL_WORKER_HTML).toContain("installAndroidTextareaDiff(terminal);");
  });

  test("translates an Android autocorrect event before xterm can replay stale text", () => {
    jest.useFakeTimers();
    try {
      const instance = terminal("this is a codex bigthis");
      installAndroidTextareaDiff()(instance);

      instance._core._compositionHelper._handleAnyTextareaChanges();
      instance.textarea.value = "this is a codex bugthis";
      jest.runOnlyPendingTimers();

      expect(instance.input).toHaveBeenCalledWith(`${DELETE.repeat(6)}ugthis`, true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("coalesces overlapping Android IME fallbacks without dropping characters", () => {
    jest.useFakeTimers();
    try {
      const instance = terminal("");
      installAndroidTextareaDiff()(instance);

      instance._core._compositionHelper._handleAnyTextareaChanges();
      instance.textarea.value = "m";
      instance._core._compositionHelper._handleAnyTextareaChanges();
      instance.textarea.value = "mo";
      jest.runOnlyPendingTimers();

      expect(instance.input).toHaveBeenCalledTimes(1);
      expect(instance.input).toHaveBeenCalledWith("mo", true);
    } finally {
      jest.useRealTimers();
    }
  });
});
