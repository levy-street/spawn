import { afterEach, describe, expect, mock, test } from "bun:test";
import { openTerminalLink } from "./terminal-link";

describe("openTerminalLink", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  test.each([
    "https://example.com/docs",
    "http://example.com/docs",
  ])("hands a safe terminal URL straight to the opener: %s", (url) => {
    const openWindow = mock((_url: string) => {});

    openTerminalLink(url, openWindow);

    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith(url);
  });

  test.each([
    "javascript:alert(1)",
    "mailto:security@example.com",
    "not a URL",
  ])("rejects an unsupported terminal URL: %s", (url) => {
    const openWindow = mock((_url: string) => {});

    openTerminalLink(url, openWindow);

    expect(openWindow).not.toHaveBeenCalled();
  });

  // The desktop shell sees only the URL a new window is opened with, so the
  // link must be named in that call — never set on a blank window afterwards.
  test("opens the link itself, isolated, in one window.open call", () => {
    const open = mock(() => null);
    globalThis.window = { open } as unknown as typeof window;

    openTerminalLink("https://example.com/docs");

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
  });
});
