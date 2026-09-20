import { render } from "@testing-library/react-native";
import type { ForwardedRef } from "react";
import { type StyleProp, StyleSheet, type ViewStyle } from "react-native";

import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import { TerminalSurface } from "@/terminal/TerminalSurface";
import type { HostTransport, SessionTransport } from "@/terminal/transport/types";
import { isWorkerBootstrapNavigation, WORKER_BASE_URL } from "@/terminal/worker/navigation-policy";
import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

type CapturedWebViewProps = Record<string, unknown> & {
  allowsLinkPreview?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  javaScriptCanOpenWindowsAutomatically?: boolean;
  onOpenWindow?: (event: { nativeEvent: { targetUrl: string } }) => void;
  onShouldStartLoadWithRequest?: (request: { url: string }) => boolean;
  originWhitelist?: readonly string[];
  setSupportMultipleWindows?: boolean;
};

const mockCapturedWebViews: CapturedWebViewProps[] = [];
const mockSessionTransport = {
  sessionId: "session-id",
  state: "idle",
  open: jest.fn(async () => undefined),
  close: jest.fn(),
  write: jest.fn(),
  resize: jest.fn(),
  requestReplay: jest.fn(),
  upload: jest.fn(),
  on: jest.fn(() => () => undefined),
} as unknown as SessionTransport;
const mockHostTransport = {
  hostId: "host-id",
  state: "idle",
  open: jest.fn(async () => undefined),
  close: jest.fn(),
  request: jest.fn(),
  stream: jest.fn(),
  on: jest.fn(() => () => undefined),
} as unknown as HostTransport;

jest.mock("react-native-webview", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  const Native = jest.requireActual<typeof import("react-native")>("react-native");
  const MockWebView = ReactModule.forwardRef(
    (props: CapturedWebViewProps, ref: ForwardedRef<{ postMessage(raw: string): void }>) => {
      mockCapturedWebViews.push(props);
      ReactModule.useImperativeHandle(ref, () => ({ postMessage: jest.fn() }));
      return ReactModule.createElement(Native.View, { testID: "contained-worker" });
    },
  );
  return { __esModule: true, default: MockWebView };
});

jest.mock("@/terminal/transport/session-transport", () => ({
  createSessionTransport: jest.fn(() => mockSessionTransport),
}));

jest.mock("@/terminal/transport/host-transport", () => ({
  createHostTransport: jest.fn(() => mockHostTransport),
  createHostConsumerTransport: jest.fn(() => mockHostTransport),
}));

jest.mock("@/theme", () => {
  const actual = jest.requireActual<typeof import("@/theme")>("@/theme");
  return { ...actual, useTheme: () => actual.darkTheme };
});

function latestWebView(): CapturedWebViewProps {
  const props = mockCapturedWebViews.at(-1);
  if (!props) throw new Error("WebView was not rendered.");
  return props;
}

describe("worker navigation containment", () => {
  beforeEach(() => {
    mockCapturedWebViews.length = 0;
    jest.clearAllMocks();
  });

  test.each([
    [WORKER_BASE_URL, true],
    ["about:blank", true],
    ["https://example.com/", false],
    ["https://example.com/new-window", false],
    ["https://spawn.local/arbitrary", false],
    ["file:///tmp/unrelated-worker.html", false],
  ])("allows only a bootstrap document: %s", (url, expected) => {
    expect(isWorkerBootstrapNavigation({ url })).toBe(expected);
  });

  test("allows only the exact configured file fallback", () => {
    const workerUrl = "file:///app/worker.html";
    expect(isWorkerBootstrapNavigation({ url: workerUrl }, workerUrl)).toBe(true);
    expect(isWorkerBootstrapNavigation({ url: `${workerUrl}?external` }, workerUrl)).toBe(false);
  });

  test("prevents the embedded worker document from opening network connections", () => {
    expect(TERMINAL_WORKER_HTML).toContain("connect-src 'none'");
  });

  test("routes every terminal URL through the strict callback and intercepts _blank", async () => {
    const onLink = jest.fn();
    await render(
      <TerminalSurface
        hostIdentityPublicKey="host-key"
        initialSize={{ cols: 80, rows: 24 }}
        onLink={onLink}
        sessionId="session-id"
      />,
    );
    const props = latestWebView();

    expect(props.originWhitelist).toEqual(["*"]);
    expect(props.onShouldStartLoadWithRequest?.({ url: WORKER_BASE_URL })).toBe(true);
    expect(props.onShouldStartLoadWithRequest?.({ url: "https://outside.example/" })).toBe(false);
    expect(props.allowsLinkPreview).toBe(false);
    expect(props.setSupportMultipleWindows).toBe(false);
    expect(props.javaScriptCanOpenWindowsAutomatically).toBe(false);

    props.onOpenWindow?.({ nativeEvent: { targetUrl: "https://outside.example/" } });
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onLink).toHaveBeenCalledWith("https://outside.example/");
  });

  test("applies the same containment policy to the hidden host worker", async () => {
    await render(
      <HostTransportSurface
        hostId="host-id"
        hostIdentityPublicKey="host-key"
        onTransport={jest.fn()}
      />,
    );
    const props = latestWebView();

    expect(props.originWhitelist).toEqual(["*"]);
    expect(props.onShouldStartLoadWithRequest?.({ url: WORKER_BASE_URL })).toBe(true);
    expect(props.onShouldStartLoadWithRequest?.({ url: "mailto:escape@example.com" })).toBe(false);
    expect(props.onOpenWindow).toEqual(expect.any(Function));
    expect(props.allowsLinkPreview).toBe(false);
    expect(props.setSupportMultipleWindows).toBe(false);
    expect(props.javaScriptCanOpenWindowsAutomatically).toBe(false);
    // The library's own container would otherwise grow to fill the column the
    // worker is mounted in, shoving a screen's toolbar down to meet it.
    expect(StyleSheet.flatten(props.containerStyle)).toMatchObject({ position: "absolute" });
  });
});
