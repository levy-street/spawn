import { act, render } from "@testing-library/react-native";
import { createRef, type ForwardedRef } from "react";
import { AppState, type AppStateStatus, Keyboard, type KeyboardEventName } from "react-native";

import { TerminalSurface, type TerminalSurfaceHandle } from "@/terminal/TerminalSurface";
import type { SessionTransport } from "@/terminal/transport/types";

const mockPostMessage = jest.fn();
const mockReload = jest.fn();
let mockWebViewProps: Record<string, unknown> & {
  onMessage?: (event: unknown) => void;
  onLayout?: () => void;
  onLoad?: () => void;
} = {};
const mockWrite = jest.fn();
const mockOpen = jest.fn(async () => undefined);
const mockClose = jest.fn();
const mockTransport = {
  sessionId: "00112233-4455-6677-8899-aabbccddeeff",
  state: "ready",
  open: mockOpen,
  close: mockClose,
  write: mockWrite,
  resize: jest.fn(),
  requestReplay: jest.fn(),
  upload: jest.fn(),
  on: jest.fn(() => () => undefined),
} as unknown as SessionTransport;

jest.mock("react-native-webview", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  const Native = jest.requireActual<typeof import("react-native")>("react-native");
  const MockWebView = ReactModule.forwardRef(
    (
      props: Record<string, unknown>,
      ref: ForwardedRef<{ postMessage(raw: string): void; reload(): void }>,
    ) => {
      mockWebViewProps = props;
      ReactModule.useImperativeHandle(ref, () => ({
        postMessage: mockPostMessage,
        reload: mockReload,
      }));
      return ReactModule.createElement(Native.View, { testID: "terminal-webview" });
    },
  );
  return { __esModule: true, default: MockWebView };
});

jest.mock("@/terminal/transport/session-transport", () => ({
  createSessionTransport: jest.fn(() => mockTransport),
}));

jest.mock("@/theme", () => {
  const actual = jest.requireActual<typeof import("@/theme")>("@/theme");
  return { ...actual, useTheme: () => actual.darkTheme };
});

function props(): React.ComponentProps<typeof TerminalSurface> {
  return {
    sessionId: "00112233-4455-6677-8899-aabbccddeeff",
    hostIdentityPublicKey: "host-key",
    initialSize: { cols: 80, rows: 24 },
  };
}

function postedTypes(): string[] {
  return mockPostMessage.mock.calls.map(([raw]) => JSON.parse(String(raw)).type as string);
}

describe("TerminalSurface", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWebViewProps = {};
    jest.spyOn(AppState, "addEventListener").mockReturnValue({
      remove: jest.fn(),
    } as unknown as ReturnType<typeof AppState.addEventListener>);
    jest.spyOn(Keyboard, "addListener").mockReturnValue({
      remove: jest.fn(),
    } as unknown as ReturnType<typeof Keyboard.addListener>);
  });

  test("renders the worker and forwards imperative handle calls", async () => {
    const ref = createRef<TerminalSurfaceHandle>();
    const screen = await render(<TerminalSurface ref={ref} {...props()} />);
    expect(screen.getByTestId("terminal-webview")).toBeTruthy();
    expect(mockWebViewProps["allowsBackForwardNavigationGestures"]).toBe(false);

    await act(() => {
      ref.current?.focus();
      ref.current?.scrollToBottom();
      ref.current?.setFollow(false);
      ref.current?.setFontSize(15);
      ref.current?.search("needle", "next");
      ref.current?.sendKey("\u0003");
    });
    expect(postedTypes()).toEqual(
      expect.arrayContaining(["focus", "scroll", "set-follow", "set-font-size", "search"]),
    );
    expect(mockWrite).toHaveBeenCalledWith(new Uint8Array([3]));
  });

  test("correlates asynchronous selection copies", async () => {
    const ref = createRef<TerminalSurfaceHandle>();
    await render(<TerminalSurface ref={ref} {...props()} />);
    let result: Promise<string | null> | undefined;
    await act(() => {
      result = ref.current?.copySelection();
    });
    const copyCall = mockPostMessage.mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { type: string; requestId?: string })
      .find((message) => message.type === "copy-selection");
    expect(copyCall?.requestId).toBeDefined();
    await act(() => {
      mockWebViewProps.onMessage?.({
        nativeEvent: {
          data: JSON.stringify({
            v: 1,
            type: "selection",
            requestId: copyCall?.requestId,
            text: "selected text",
          }),
        },
      });
    });
    await expect(result).resolves.toBe("selected text");
  });

  test("defers fit throughout the soft-keyboard transition", async () => {
    jest.useFakeTimers();
    const listeners = new Map<KeyboardEventName, () => void>();
    const keyboard = jest.spyOn(Keyboard, "addListener").mockImplementation((event, listener) => {
      listeners.set(event, listener as () => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof Keyboard.addListener>;
    });
    await render(<TerminalSurface {...props()} />);
    listeners.get("keyboardWillShow")?.();
    await act(() => {
      mockWebViewProps.onLayout?.();
      jest.advanceTimersByTime(1_000);
    });
    expect(postedTypes()).not.toContain("fit");

    await act(() => {
      listeners.get("keyboardDidShow")?.();
      jest.advanceTimersByTime(100);
    });
    expect(postedTypes()).toContain("fit");
    keyboard.mockRestore();
    jest.useRealTimers();
  });

  test.each([2_999, 3_000, 5_549])(
    "foreground checks %i ms elapsed while terminal background timers were suspended",
    async (elapsed) => {
      jest.useFakeTimers();
      let listener: ((state: AppStateStatus) => void) | undefined;
      const appState = jest
        .spyOn(AppState, "addEventListener")
        .mockImplementation((_type, next) => {
          listener = next;
          return { remove: jest.fn() };
        });
      const screen = await render(<TerminalSurface {...props()} />);
      try {
        await act(() => mockWebViewProps.onLoad?.());
        await act(() => listener?.("active"));
        const started = Date.now();
        await act(() => listener?.("background"));
        jest.setSystemTime(started + 1_000);
        await act(() => listener?.("background"));
        await act(() => listener?.("inactive"));
        jest.setSystemTime(started + elapsed);
        expect(mockClose).not.toHaveBeenCalled();
        await act(() => listener?.("active"));
        const retired = elapsed >= 3_000 ? 1 : 0;
        expect(mockClose).toHaveBeenCalledTimes(retired);
        expect(mockOpen).toHaveBeenCalledTimes(1 + retired);
        if (retired) {
          expect(mockClose.mock.invocationCallOrder[0]).toBeLessThan(
            mockOpen.mock.invocationCallOrder[1] ?? 0,
          );
        }
        await act(() => jest.advanceTimersByTime(3_000));
        await act(() => listener?.("active"));
        expect(mockClose).toHaveBeenCalledTimes(retired);
        expect(mockOpen).toHaveBeenCalledTimes(1 + retired);
      } finally {
        await screen.unmount();
        appState.mockRestore();
        jest.useRealTimers();
      }
    },
  );

  test("an earlier background callback cannot retire a new terminal grace period", async () => {
    jest.useFakeTimers();
    const timers = jest.spyOn(globalThis, "setTimeout");
    let listener: ((state: AppStateStatus) => void) | undefined;
    const appState = jest.spyOn(AppState, "addEventListener").mockImplementation((_type, next) => {
      listener = next;
      return { remove: jest.fn() };
    });
    const screen = await render(<TerminalSurface {...props()} />);
    try {
      await act(() => mockWebViewProps.onLoad?.());
      await act(() => listener?.("active"));
      await act(() => listener?.("background"));
      const oldTimer = timers.mock.calls.findLast((call) => call[1] === 3_000)?.[0];
      if (typeof oldTimer !== "function") throw new Error("Missing retirement timer.");
      jest.setSystemTime(Date.now() + 1_000);
      await act(() => listener?.("active"));
      await act(() => listener?.("background"));
      jest.setSystemTime(Date.now() + 1_000);
      await act(() => oldTimer());
      expect(mockClose).not.toHaveBeenCalled();
      jest.setSystemTime(Date.now() + 2_000);
      await act(() => listener?.("active"));
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockOpen).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
      appState.mockRestore();
      timers.mockRestore();
      jest.useRealTimers();
    }
  });

  test("retires in background and reconnects after foregrounding", async () => {
    jest.useFakeTimers();
    let listener: ((state: AppStateStatus) => void) | undefined;
    const appState = jest.spyOn(AppState, "addEventListener").mockImplementation((_type, next) => {
      listener = next;
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    await render(<TerminalSurface {...props()} />);
    await act(() => mockWebViewProps.onLoad?.());
    await act(() => listener?.("active"));
    expect(mockOpen).toHaveBeenCalledTimes(1);
    await act(() => listener?.("inactive"));
    await act(() => jest.advanceTimersByTime(3_000));
    expect(mockClose).not.toHaveBeenCalled();
    await act(() => listener?.("background"));
    await act(() => jest.advanceTimersByTime(2_999));
    expect(mockClose).not.toHaveBeenCalled();
    await act(() => listener?.("active"));
    await act(() => jest.advanceTimersByTime(1));
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalledTimes(1);
    await act(() => listener?.("background"));
    await act(() => jest.advanceTimersByTime(3_000));
    expect(mockClose).toHaveBeenCalledTimes(1);
    await act(() => listener?.("active"));
    expect(mockOpen).toHaveBeenCalledTimes(2);
    appState.mockRestore();
    jest.useRealTimers();
  });
});
