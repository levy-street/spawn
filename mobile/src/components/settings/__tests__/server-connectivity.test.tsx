import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import SettingsIndexRoute from "@/app/(drawer)/(tabs)/settings/index";
import { SignedOutServerScreen } from "@/components/auth/server-form";
import { ServerPanel, testServerConnection } from "@/components/settings/server-panel";
import { authToken } from "@/data/api/auth-token";
import { getBaseUrlResolution, setBaseUrl } from "@/data/api/config";
import { ThemeProvider } from "@/theme";

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockConnectionReset = jest.fn();
const mockBack = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({
    back: mockBack,
    canGoBack: () => true,
    push: mockPush,
    replace: mockReplace,
  }),
}));

jest.mock("@/data/api/auth-token", () => ({
  authToken: {
    get: jest.fn(async () => "token"),
    set: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
    captureFromResponse: jest.fn(async () => null),
  },
}));

jest.mock("@/data/api/config", () => {
  const actual = jest.requireActual<typeof import("@/data/api/config")>("@/data/api/config");
  return {
    ...actual,
    getBaseUrlResolution: jest.fn(async () => ({
      url: "https://current.spawn.test",
      source: "expo.extra",
    })),
    setBaseUrl: jest.fn(async () => undefined),
  };
});

jest.mock("@/data/stores/connection", () => ({
  useConnectionStore: {
    getState: () => ({ reset: mockConnectionReset }),
  },
}));

jest.mock("@/data/queries/settings", () => ({
  useMeSettingsQuery: () => ({ data: undefined, isPending: false }),
}));

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        }}
      >
        <ThemeProvider>{children}</ThemeProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

describe("testServerConnection", () => {
  test("requests the unauthenticated health endpoint", async () => {
    const request = jest.fn(async () => ({ ok: true, status: 200, statusText: "OK" }) as Response);

    await expect(testServerConnection("spawn.example.com/", request)).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith("https://spawn.example.com/healthz", {
      credentials: "omit",
      headers: { Accept: "application/json" },
      method: "GET",
    });
  });

  test("reports HTTP and network failures without hiding their cause", async () => {
    const unavailable = jest.fn(
      async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }) as Response,
    );
    await expect(testServerConnection("https://spawn.example.com", unavailable)).rejects.toThrow(
      "Server responded with 503 Service Unavailable",
    );

    const offline = jest.fn(async () => {
      throw new Error("Network request failed");
    });
    await expect(testServerConnection("https://spawn.example.com", offline)).rejects.toThrow(
      "Network request failed",
    );
  });
});

describe("ServerPanel", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getBaseUrlResolution).mockResolvedValue({
      url: "https://current.spawn.test",
      source: "expo.extra",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("shows effective URL provenance and both connection outcomes", async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" } as Response)
      .mockRejectedValueOnce(
        new Error("The Internet connection appears to be offline."),
      ) as jest.MockedFunction<typeof fetch>;
    const screen = await render(<ServerPanel />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("effective-server-url")).toHaveTextContent(
        "https://current.spawn.test",
      );
      expect(screen.getByTestId("server-url-source")).toHaveTextContent("expo.extra");
    });

    await fireEvent.press(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => {
      expect(screen.getByTestId("connection-result")).toHaveTextContent(
        "Connected to https://current.spawn.test.",
      );
    });

    await fireEvent.press(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => {
      expect(screen.getByTestId("connection-result")).toHaveTextContent(
        "Connection failed: The Internet connection appears to be offline.",
      );
    });
  });

  test("clears the current token before changing servers and signs out", async () => {
    const screen = await render(<ServerPanel />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId("server-url-input")).toHaveDisplayValue(
        "https://current.spawn.test",
      ),
    );

    await fireEvent.changeText(screen.getByTestId("server-url-input"), " new.spawn.test/// ");
    await fireEvent.press(screen.getByRole("button", { name: "Save server" }));

    await waitFor(() => {
      expect(authToken.clear).toHaveBeenCalledTimes(1);
      expect(setBaseUrl).toHaveBeenCalledWith("https://new.spawn.test");
      expect(mockConnectionReset).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
    expect(jest.mocked(authToken.clear).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(setBaseUrl).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});

describe("SignedOutServerScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getBaseUrlResolution).mockResolvedValue({
      url: "https://current.spawn.test",
      source: "expo.extra",
    });
  });

  test("puts the signed-out server switch on the account sheet, not in app chrome", async () => {
    const screen = await render(<SignedOutServerScreen />, { wrapper });

    expect(screen.getByTestId("auth-sheet")).toBeTruthy();
    expect(screen.queryByTestId("server-panel")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("effective-server-url")).toHaveTextContent(
        "https://current.spawn.test",
      ),
    );
  });

  test("changes servers and returns to sign-in", async () => {
    const screen = await render(<SignedOutServerScreen />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId("server-url-input")).toHaveDisplayValue(
        "https://current.spawn.test",
      ),
    );

    await fireEvent.changeText(screen.getByTestId("server-url-input"), " new.spawn.test/// ");
    await fireEvent.press(screen.getByRole("button", { name: "Save server" }));

    await waitFor(() => {
      expect(authToken.clear).toHaveBeenCalledTimes(1);
      expect(setBaseUrl).toHaveBeenCalledWith("https://new.spawn.test");
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
  });
});

describe("Settings connectivity routes", () => {
  test("renders and routes the Server and About rows", async () => {
    const screen = await render(<SettingsIndexRoute />, { wrapper });

    await fireEvent.press(screen.getByTestId("settings-panel-server"));
    expect(mockPush).toHaveBeenLastCalledWith("/settings/server");

    await fireEvent.press(screen.getByTestId("settings-panel-about"));
    expect(mockPush).toHaveBeenLastCalledWith("/settings/about");
  });
});
