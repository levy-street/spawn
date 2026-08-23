import { render, within } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AgentsPanel } from "@/components/settings/agents-panel";
import type { AgentOut } from "@/data/api/schemas/agents";
import { FixedThemeProvider, lightTheme, opacity } from "@/theme";

const mockPreferenceMutate = jest.fn();
let mockAgents: AgentOut[] = [];

jest.mock("@/data/queries/settings", () => ({
  useAgentsSettingsQuery: () => ({
    data: mockAgents,
    error: null,
    isPending: false,
  }),
  useAgentMutations: () => ({
    create: { isPending: false, mutateAsync: jest.fn() },
    patch: { isPending: false, mutateAsync: jest.fn() },
    preference: { isPending: false, mutate: mockPreferenceMutate },
    remove: { isPending: false, mutate: jest.fn() },
  }),
}));

function wrapper({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, right: 0, bottom: 34, left: 0 },
      }}
    >
      <FixedThemeProvider mode="light">{children}</FixedThemeProvider>
    </SafeAreaProvider>
  );
}

function agent(overrides: Partial<AgentOut>): AgentOut {
  return {
    command: "codex",
    env: {},
    id: "agent-default",
    install: null,
    kind: "codex",
    name: "Codex",
    owner_user_id: null,
    yolo: false,
    yolo_args: null,
    yolo_env: {},
    ...overrides,
  };
}

describe("agent yolo controls", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgents = [
      agent({
        id: "active",
        name: "Codex active",
        yolo: true,
        yolo_args: "--dangerously-bypass-approvals-and-sandbox",
        yolo_env: { SPAWN_YOLO: "1" },
      }),
      agent({ id: "unavailable", name: "Codex safe" }),
    ];
  });

  test("labels active yolo mode in amber and appends its command suffix", async () => {
    const screen = await render(<AgentsPanel />, { wrapper });
    const activeLabel = within(screen.getByTestId("agent-yolo-label-active")).getByText("yolo");
    const suffix = screen.getByTestId("agent-yolo-suffix-active");

    expect(activeLabel).toHaveStyle({ color: lightTheme.colors.warning });
    expect(suffix).toHaveStyle({ color: lightTheme.colors.warning });
    expect(suffix).toHaveTextContent("+SPAWN_YOLO --dangerously-bypass-approvals-and-sandbox");
    expect(screen.getByRole("switch", { name: "Yolo mode for Codex active" })).toBeChecked();
  });

  test("keeps the yolo label muted and switch disabled when the agent has no yolo mode", async () => {
    const screen = await render(<AgentsPanel />, { wrapper });
    const unavailableLabel = screen.getByTestId("agent-yolo-label-unavailable");
    const unavailableText = within(unavailableLabel).getByText("yolo");

    expect(unavailableLabel).toHaveStyle({ opacity: opacity.disabled });
    expect(unavailableText).toHaveStyle({ color: lightTheme.colors.mutedForeground });
    expect(screen.queryByTestId("agent-yolo-suffix-unavailable")).toBeNull();
    const unavailableSwitch = screen.getByRole("switch", { name: "Yolo mode for Codex safe" });
    expect(unavailableSwitch).not.toBeChecked();
    expect(unavailableSwitch).toBeDisabled();
  });
});
