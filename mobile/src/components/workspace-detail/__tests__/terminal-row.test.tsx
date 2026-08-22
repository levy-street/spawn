import { render } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { TerminalRow } from "@/components/workspace-detail/terminal-row";
import * as sessionSelectors from "@/data/selectors/session";
import { ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

import { makeAgent, makeHost, makeSession } from "./fixtures";

jest.mock("react-native-gesture-handler", () => {
  const actual = jest.requireActual<typeof import("react-native-gesture-handler")>(
    "react-native-gesture-handler",
  );
  return {
    ...actual,
    GestureDetector: ({ children }: { children: ReactNode }) => children,
  };
});

const handlers = {
  onOpen: jest.fn(),
  onActions: jest.fn(),
  onRename: jest.fn(),
  onMove: jest.fn(),
  onClose: jest.fn(),
};

describe("TerminalRow", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ["claude", "claude-code", "Claude Code", "claude-code"],
    ["codex", "codex", "Codex", "codex"],
    ["opencode", "opencode", "OpenCode", "opencode"],
    ["aider", "aider", "Aider Sonnet", "aider"],
  ])("renders the %s built-in identity", async (command, kind, label, icon) => {
    const screen = await render(
      <TerminalRow
        {...handlers}
        agents={[
          makeAgent({
            command,
            kind,
            name: label,
          }),
        ]}
        host={makeHost()}
        session={makeSession({ foreground_command: command })}
        transport="idle"
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByTestId(`agent-icon-${icon}`, { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText(new RegExp(label))).toBeTruthy();
    expect(screen.getByText("Implement mobile")).toBeTruthy();
    expect(screen.getByText("Quiet")).toBeTruthy();
  });

  it("renders a custom agent as a monogram with its definition name", async () => {
    const screen = await render(
      <TerminalRow
        {...handlers}
        agents={[makeAgent({ command: "nebula", kind: "private", name: "Nebula" })]}
        host={makeHost()}
        session={makeSession({ foreground_command: "nebula" })}
        transport="idle"
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByTestId("agent-icon-monogram", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText(/Nebula/)).toBeTruthy();
  });

  it.each([
    ["unknown command", "htop", "htop", "agent-icon-monogram"],
    ["null command", null, "Shell", "agent-icon-shell"],
  ])("renders the %s fallback", async (_case, command, label, icon) => {
    const screen = await render(
      <TerminalRow
        {...handlers}
        agents={[]}
        host={makeHost()}
        session={makeSession({ foreground_command: command })}
        transport="idle"
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByTestId(icon, { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText(new RegExp(label))).toBeTruthy();
  });

  it("renders the composed displayStatus result instead of recomputing a label", async () => {
    const session = makeSession();
    const host = makeHost();
    const displayStatus = jest.spyOn(sessionSelectors, "displayStatus").mockReturnValue({
      process: "running",
      activity: "active",
      host: "online",
      transport: "idle",
      transportPresentation: "connecting",
      attention: null,
      label: "Composed status",
      tone: "waiting",
      pulse: false,
    });

    const screen = await render(
      <TerminalRow
        {...handlers}
        agents={[makeAgent()]}
        host={host}
        session={session}
        transport="idle"
      />,
      { wrapper: ThemeProvider },
    );

    expect(displayStatus).toHaveBeenCalledWith(session, host, "idle");
    expect(screen.getByText("Composed status")).toBeTruthy();
    expect(
      screen.getByLabelText("Implement mobile, Codex · office-mac · /Users/spawn/dev/spawn"),
    ).toHaveStyle({
      minHeight: sizing.listRow.tall,
      paddingHorizontal: sizing.listRow.horizontalPadding,
      paddingVertical: sizing.listRow.verticalPadding,
    });
    displayStatus.mockRestore();
  });
});
