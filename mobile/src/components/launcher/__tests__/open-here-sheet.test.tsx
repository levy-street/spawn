import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { CreateWindowRequest } from "@/components/launcher/create-window";
import {
  type OpenHereRequest,
  OpenHereSheet,
  orderWorkspaceTargets,
} from "@/components/launcher/open-here-sheet";
import { ThemeProvider } from "@/theme";
import { fullTab, makeAgent, makeHost, makeSession, makeWorkspace } from "./fixtures";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

const host = makeHost();
const mockCodex = makeAgent({ name: "Codex" });
const created = makeSession({ id: "30000000-0000-4000-8000-0000000000ff" });
const mockAlpha = makeWorkspace({ id: "40000000-0000-4000-8000-00000000000a", name: "Alpha" });
const mockBeta = makeWorkspace({ id: "40000000-0000-4000-8000-00000000000b", name: "Beta" });
const mockFull = makeWorkspace({
  id: "40000000-0000-4000-8000-00000000000f",
  name: "Packed",
  layout: { version: 3, active_tab: "tab-1", tabs: [fullTab()] },
});

const mockCreateWindow = jest.fn(async (request: CreateWindowRequest) => ({
  status: "created" as const,
  session: created,
  workspaceId:
    request.workspace?.kind === "workspace"
      ? request.workspace.workspaceId
      : "40000000-0000-4000-8000-0000000000ee",
  pendingCommand: Boolean(request.agent),
}));
const mockRemember = jest.fn();
let mockLastWorkspace: string | null = null;

jest.mock("@/terminal/HostTransportSurface", () => ({ HostTransportSurface: () => null }));
jest.mock("@/components/hosts/host-update-dialog", () => ({ HostUpdateDialog: () => null }));
jest.mock("@/components/trust/device-approval-gate", () => ({
  useDeviceApprovalGate: () => ({
    guard: (_hostId: string, run: () => void) => run(),
    overlay: null,
  }),
}));
jest.mock("@/data/queries/hosts", () => ({
  useAgentsQuery: () => ({ data: [mockCodex], isPending: false }),
}));
jest.mock("@/data/queries/workspaces", () => ({
  useWorkspacesQuery: () => ({ data: [mockAlpha, mockBeta, mockFull], isPending: false }),
}));
jest.mock("@/data/queries/launcher", () => ({
  useCreateWindow: () => ({ isPending: false, mutateAsync: mockCreateWindow }),
}));
jest.mock("@/data/stores/last-workspace", () => ({
  readLastWorkspace: async () => mockLastWorkspace,
  rememberLastWorkspace: (id: string) => mockRemember(id),
}));

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>{children}</ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

async function renderSheet(request: OpenHereRequest, sheetHost = host) {
  const onOpened = jest.fn();
  const onDismiss = jest.fn();
  await render(
    <OpenHereSheet
      host={sheetHost}
      onDismiss={onDismiss}
      onOpened={onOpened}
      request={request}
      sessions={[
        makeSession({ cwd: "/Users/ada/spawn" }),
        makeSession({
          id: "elsewhere",
          host_id: "20000000-0000-4000-8000-000000000009",
          cwd: "/srv",
        }),
      ]}
    />,
    { wrapper: Providers },
  );
  // The last workspace is read from storage as the sheet opens.
  await act(async () => undefined);
  return { onOpened, onDismiss };
}

describe("New window here", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLastWorkspace = mockBeta.id;
  });

  test("asks what, then where on this host only, then which workspace", async () => {
    const { onOpened, onDismiss } = await renderSheet({ cwd: null });

    expect(screen.getByText(`New window on ${host.name}`)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`open-here-agent-${mockCodex.id}`));

    expect(screen.getByText(`Where on ${host.name}?`)).toBeOnTheScreen();
    // This host's places only: a window's folder on another host is not offered.
    expect(screen.getByText("~/spawn")).toBeOnTheScreen();
    expect(screen.queryByText("/srv")).toBeNull();
    expect(screen.getByText(`Browse ${host.name}`)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("open-here-where-suggested"));

    expect(screen.getByText("Open in which workspace?")).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`open-here-workspace-${mockAlpha.id}`));

    expect(mockCreateWindow).toHaveBeenCalledWith({
      host,
      cwd: "/Users/ada/spawn",
      agent: mockCodex,
      workspace: { kind: "workspace", workspaceId: mockAlpha.id },
    });
    expect(mockRemember).toHaveBeenCalledWith(mockAlpha.id);
    expect(onOpened).toHaveBeenCalledWith({ workspaceId: mockAlpha.id, sessionId: created.id });
    expect(onDismiss).toHaveBeenCalled();
  });

  test("offers the workspace used last first, and a full one it cannot join", async () => {
    await renderSheet({ cwd: "/Users/ada/spawn", run: "shell" });

    // Opened from a folder as a shell: straight to which workspace.
    expect(screen.getByText("Open in which workspace?")).toBeOnTheScreen();
    expect(screen.getByText(`Shell in ~/spawn on ${host.name}`)).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Beta" })).toBeOnTheScreen();
    expect(screen.getByText("Last used")).toBeOnTheScreen();
    expect(screen.getByText("Full")).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`open-here-workspace-${mockFull.id}`));
    expect(mockCreateWindow).not.toHaveBeenCalled();
  });

  test("a new workspace starts with the window", async () => {
    const { onOpened } = await renderSheet({ cwd: "~", run: "shell" });
    await fireEvent.press(screen.getByTestId("open-here-new-workspace"));

    expect(mockCreateWindow).toHaveBeenCalledWith({
      host,
      cwd: "~",
      workspace: { kind: "new-workspace" },
    });
    expect(onOpened).toHaveBeenCalledWith({
      workspaceId: "40000000-0000-4000-8000-0000000000ee",
      sessionId: created.id,
    });
  });

  test("starting an agent from a folder asks only which agent", async () => {
    await renderSheet({ cwd: "/Users/ada/spawn", run: "agent" });

    expect(screen.queryByTestId("open-here-shell")).toBeNull();
    await fireEvent.press(screen.getByTestId(`open-here-agent-${mockCodex.id}`));
    expect(screen.getByText("Open in which workspace?")).toBeOnTheScreen();

    // Back to the choice, and the folder it was opened from is kept.
    await fireEvent.press(screen.getByRole("button", { name: "Go back" }));
    expect(screen.getByText(`New window on ${host.name}`)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`open-here-agent-${mockCodex.id}`));
    expect(screen.getByText(`Codex in ~/spawn on ${host.name}`)).toBeOnTheScreen();
  });

  test("a host this device holds no key for offers its places, but no folder browse", async () => {
    const keyless = { ...host, host_public_key: null };
    await renderSheet({ cwd: null, run: "shell" }, keyless);

    expect(screen.getByText(`Where on ${host.name}?`)).toBeOnTheScreen();
    const browse = screen.getByTestId("open-here-where-browse");
    expect(browse).toBeDisabled();
    expect(
      screen.getByText(
        "Reconnect this host to establish its trusted identity before browsing files.",
      ),
    ).toBeOnTheScreen();
    await fireEvent.press(browse);
    expect(screen.getByText(`Where on ${host.name}?`)).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("open-here-where-suggested"));
    expect(screen.getByText("Open in which workspace?")).toBeOnTheScreen();
  });

  test("orders the last workspace first and ignores one this account does not have", () => {
    expect(
      orderWorkspaceTargets([mockAlpha, mockBeta], mockBeta.id).map(
        (target) => target.workspace.name,
      ),
    ).toEqual(["Beta", "Alpha"]);
    expect(
      orderWorkspaceTargets([mockAlpha, mockBeta], "gone").every((target) => !target.last),
    ).toBe(true);
  });
});
