import { fireEvent, render, screen } from "@testing-library/react-native";
import { act } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import HostFilesRoute from "@/app/(drawer)/host/[id]/files";
import type { FolderNavigation } from "@/components/files/file-browser-body";
import { HOST_IDENTITY_BLOCKED_REASON } from "@/components/hosts/host-trust-copy";
import { ThemeProvider } from "@/theme";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const mockPush = jest.fn();
const mockDismiss = jest.fn();
const mockBack = jest.fn();
let mockParams: Record<string, string> = { id: HOST_ID };
let mockStack: { routes: { name: string; params?: object }[]; index: number } = {
  routes: [],
  index: 0,
};
let mockHome: { home_dir: string } | undefined = { home_dir: "/home/me" };
let mockOpenFolder: ((navigation: FolderNavigation) => void) | null = null;
let mockIdentityConflict = false;
let mockExplorerMounted = false;
const mockRemove = jest.fn();
const mockReplace = jest.fn();

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ getState: () => mockStack }),
  useRouter: () => ({ back: mockBack, dismiss: mockDismiss, push: mockPush, replace: mockReplace }),
}));

jest.mock("@/data/queries/hosts", () => ({
  useHostIdentityConflictQuery: () => ({ data: mockIdentityConflict }),
  useRemoveHostMutation: () => ({ error: null, isPending: false, mutate: mockRemove }),
}));

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ error: jest.fn(), success: jest.fn() }),
}));

jest.mock("@/data/queries/files", () => ({
  useFileHost: () => ({
    data: {
      id: HOST_ID,
      name: "dream",
      os: "linux",
      status: "online",
      host_public_key: "pk",
    },
    isError: false,
    isLoading: false,
  }),
  useHostHome: () => ({ data: mockHome }),
}));

jest.mock("@/components/files/file-explorer", () => ({
  FileExplorer: ({ onOpenFolder }: { onOpenFolder(navigation: FolderNavigation): void }) => {
    mockOpenFolder = onOpenFolder;
    mockExplorerMounted = true;
    return null;
  },
}));

const files = (path?: string) => ({
  name: "host/[id]/files",
  params: path === undefined ? { id: HOST_ID } : { id: HOST_ID, path },
});

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

async function renderRoute() {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <HostFilesRoute />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

async function open(navigation: FolderNavigation) {
  await renderRoute();
  await act(async () => mockOpenFolder?.(navigation));
}

beforeEach(() => {
  mockPush.mockClear();
  mockDismiss.mockClear();
  mockParams = { id: HOST_ID };
  mockHome = { home_dir: "/home/me" };
  mockOpenFolder = null;
  mockIdentityConflict = false;
  mockExplorerMounted = false;
  mockRemove.mockClear();
});

describe("host files route", () => {
  test("a folder opens as a screen of its own, so back returns to this one", async () => {
    mockStack = { routes: [files()], index: 0 };
    await open({ path: "/home/me/code", ancestor: false });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/host/[id]/files",
      params: { id: HOST_ID, path: "/home/me/code" },
    });
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  test("a breadcrumb goes back to its folder when it is underneath", async () => {
    mockParams = { id: HOST_ID, path: "/home/me/code/spawn" };
    mockStack = {
      routes: [{ name: "(tabs)" }, files(), files("/home/me/code"), files("/home/me/code/spawn")],
      index: 3,
    };
    await open({ path: "/home/me", ancestor: true });
    expect(mockDismiss).toHaveBeenCalledWith(2);
    expect(mockPush).not.toHaveBeenCalled();
  });

  test("a breadcrumb above where the explorer was opened pushes that folder", async () => {
    mockParams = { id: HOST_ID, path: "~/code/spawn" };
    mockStack = { routes: [{ name: "terminal/[sessionId]" }, files("~/code/spawn")], index: 1 };
    await open({ path: "/home/me/code", ancestor: true });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/host/[id]/files",
      params: { id: HOST_ID, path: "/home/me/code" },
    });
  });

  test("a deep link's ~ spelling matches the same folder underneath", async () => {
    mockStack = { routes: [files("~/code"), files("/home/me/code/spawn")], index: 1 };
    await open({ path: "/home/me/code", ancestor: true });
    expect(mockDismiss).toHaveBeenCalledWith(1);
  });

  test("before the host's home is known, a breadcrumb simply pushes", async () => {
    mockHome = undefined;
    mockStack = { routes: [files(), files("/home/me/code")], index: 1 };
    await open({ path: "/home/me", ancestor: true });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  test("a host whose identity changed keeps its files shut, even from a link", async () => {
    mockIdentityConflict = true;
    mockParams = { id: HOST_ID, path: "/home/me/code" };
    await renderRoute();
    expect(mockExplorerMounted).toBe(false);
    expect(screen.getByTestId("host-identity-conflict")).toBeOnTheScreen();
    expect(screen.getByText("Files are blocked")).toBeOnTheScreen();
    expect(screen.getByText(HOST_IDENTITY_BLOCKED_REASON)).toBeOnTheScreen();

    // The panel's one way out is removal, after a confirm that closes on the answer.
    await fireEvent.press(screen.getByTestId("conflict-remove-host"));
    await fireEvent.press(screen.getByRole("button", { name: "Remove host" }));
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  test("an approved host opens its files", async () => {
    await renderRoute();
    expect(mockExplorerMounted).toBe(true);
    expect(screen.queryByText("Files are blocked")).toBeNull();
  });
});
