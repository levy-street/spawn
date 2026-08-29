import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

const DELETE = "\u007f";

/**
 * The Android IME adapter runs inside the bundled WebView worker. Extracting
 * its pure edit translator lets these event shapes stay deterministic without
 * needing a particular phone, keyboard, or WebView version in Jest.
 */
function textareaEditSequence(): (previous: string, next: string) => string {
  const start = TERMINAL_WORKER_HTML.indexOf(
    "  function textareaEditSequence(previous, next) {",
  );
  const end = TERMINAL_WORKER_HTML.indexOf("\n  function installAndroidTextareaDiff(", start);
  if (start < 0 || end < start) throw new Error("Android textarea edit translation is missing.");

  const source = TERMINAL_WORKER_HTML.slice(start, end);
  return new Function("DELETE", `${source}\nreturn textareaEditSequence;`)(DELETE) as (
    previous: string,
    next: string,
  ) => string;
}

describe("Android terminal IME input", () => {
  test("sends only newly appended text", () => {
    expect(textareaEditSequence()("this is on the Android app", "this is on the Android app fyi")).toBe(
      " fyi",
    );
  });

  test("rewinds and replaces an autocorrected word without replaying the prompt", () => {
    expect(textareaEditSequence()("this is a codex bigthis", "this is a codex bugthis")).toBe(
      DELETE.repeat(6) + "ugthis",
    );
  });

  test("handles corrections that change length and retain trailing text", () => {
    expect(textareaEditSequence()("please fx this", "please fix this")).toBe(
      DELETE.repeat(6) + "ix this",
    );
  });

  test("uses Unicode characters rather than UTF-16 units when rewinding", () => {
    expect(textareaEditSequence()("say 😺x", "say 😸x")).toBe(DELETE.repeat(2) + "😸x");
  });

  test("does nothing for an unchanged textarea", () => {
    expect(textareaEditSequence()("unchanged", "unchanged")).toBe("");
  });

  test("installs the adapter on the xterm instance", () => {
    expect(TERMINAL_WORKER_HTML).toContain("installAndroidTextareaDiff(terminal);");
  });
});
