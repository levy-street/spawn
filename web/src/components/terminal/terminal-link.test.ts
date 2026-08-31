import { describe, expect, mock, test } from "bun:test";
import { openTerminalLink } from "./terminal-link";

describe("openTerminalLink", () => {
  test.each([
    "https://example.com/docs",
    "http://example.com/docs",
  ])("opens a safe terminal URL in an isolated window: %s", (url) => {
    const openedWindow = {
      opener: {} as unknown,
      location: { href: "" },
    };
    const openWindow = mock(() => openedWindow);

    openTerminalLink(url, openWindow);

    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openedWindow.opener).toBeNull();
    expect(openedWindow.location.href).toBe(url);
  });

  test.each([
    "javascript:alert(1)",
    "mailto:security@example.com",
    "not a URL",
  ])("rejects an unsupported terminal URL: %s", (url) => {
    const openWindow = mock(() => null);

    openTerminalLink(url, openWindow);

    expect(openWindow).not.toHaveBeenCalled();
  });

  test("does not navigate when opener isolation cannot be established", () => {
    const openedWindow = { location: { href: "" } } as {
      opener: unknown;
      location: { href: string };
    };
    Object.defineProperty(openedWindow, "opener", {
      set: () => {
        throw new Error("opener is read-only");
      },
    });

    openTerminalLink("https://example.com/docs", () => openedWindow);

    expect(openedWindow.location.href).toBe("");
  });
});
