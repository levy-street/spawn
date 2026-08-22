import { fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { WorkspaceHeader } from "@/components/workspace-detail/workspace-header";
import { ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

import { makeWorkspace } from "./fixtures";

function Providers({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, right: 0, bottom: 34, left: 0 },
      }}
    >
      <ThemeProvider>{children}</ThemeProvider>
    </SafeAreaProvider>
  );
}

describe("WorkspaceHeader", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders in-scene chrome and wires back, launcher, and workspace actions", async () => {
    const onBack = jest.fn();
    const onAddPane = jest.fn();
    const onActions = jest.fn();
    const screen = await render(
      <WorkspaceHeader
        canAddPane
        onActions={onActions}
        onAddPane={onAddPane}
        onBack={onBack}
        workspace={makeWorkspace()}
      />,
      { wrapper: Providers },
    );

    expect(screen.getByRole("header", { name: "spawn mobile" })).toBeTruthy();
    const add = screen.getByLabelText("Add terminal or files");
    expect(add).toHaveStyle({
      height: sizing.appHeader.actionTarget,
      width: sizing.appHeader.actionTarget,
    });

    await fireEvent.press(add);
    await fireEvent.press(screen.getByLabelText("Workspace actions"));
    await fireEvent.press(screen.getByLabelText("Go back"));
    expect(onAddPane).toHaveBeenCalledTimes(1);
    expect(onActions).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("disables launcher access when the active tab is full", async () => {
    const onAddPane = jest.fn();
    const screen = await render(
      <WorkspaceHeader
        canAddPane={false}
        onActions={jest.fn()}
        onAddPane={onAddPane}
        onBack={jest.fn()}
        workspace={makeWorkspace()}
      />,
      { wrapper: Providers },
    );

    const add = screen.getByLabelText("Add terminal or files");
    expect(add).toBeDisabled();
    await fireEvent.press(add);
    expect(onAddPane).not.toHaveBeenCalled();
  });
});
