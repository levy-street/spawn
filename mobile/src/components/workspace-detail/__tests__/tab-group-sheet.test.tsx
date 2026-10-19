import { act, fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren, ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  TAB_GROUP_EDIT_DEBOUNCE_MS,
  TabGroupSheet,
  type TabGroupSheetProps,
} from "@/components/workspace-detail/tab-group-sheet";
import type { TabGroup } from "@/data/types/layout";
import { lightColors, ThemeProvider } from "@/theme";

// The drawer itself has its own suites; here it only has to show what it holds.
jest.mock("@/components/ui/sheet", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { ScrollView, Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Sheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
      visible ? React.createElement(View, { testID: "sheet" }, children) : null,
    SheetHeader: ({ title }: { title: string }) =>
      React.createElement(Text, { accessibilityRole: "header" }, title),
    SheetScrollView: ScrollView,
  };
});

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

const agents: TabGroup = {
  id: "agents",
  name: "Agents",
  color: "orange",
  collapsed: false,
  tab_ids: ["tests", "server"],
};

function renderSheet(overrides: Partial<TabGroupSheetProps> = {}) {
  const props: TabGroupSheetProps = {
    visible: true,
    mode: "manage",
    group: agents,
    canAddTab: true,
    onUpdate: jest.fn(),
    onCancel: jest.fn(),
    onNewTab: jest.fn(),
    onToggleCollapsed: jest.fn(),
    onUngroup: jest.fn(),
    onDismiss: jest.fn(),
    ...overrides,
  };
  return { props, result: render(<TabGroupSheet {...props} />, { wrapper: Providers }) };
}

describe("TabGroupSheet", () => {
  it("creates: a name, nine presets and a custom colour, then Cancel or Done", async () => {
    const { result } = renderSheet({ mode: "create", group: { ...agents, name: "" } });
    const screen = await result;

    expect(screen.getByText("Create tab group")).toBeTruthy();
    expect(screen.getByText("Name")).toBeTruthy();
    expect(screen.getByTestId("tab-group-name")).toHaveProp("placeholder", "Unnamed group");
    expect(screen.getAllByRole("radio")).toHaveLength(10);
    expect(screen.getByLabelText("Orange")).toHaveProp("accessibilityState", { checked: true });
    expect(screen.getByLabelText("Custom")).toHaveProp("accessibilityState", { checked: false });
    expect(screen.getByText("Cancel")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByText("New tab in group")).toBeNull();
  });

  it("applies name and colour together once typing rests, and Done saves at once", async () => {
    jest.useFakeTimers();
    const { props, result } = renderSheet();
    const screen = await result;

    await fireEvent.changeText(screen.getByTestId("tab-group-name"), "Bots ");
    await fireEvent.press(screen.getByLabelText("Red"));
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Red")).toHaveProp("accessibilityState", { checked: true });

    await act(async () => {
      jest.advanceTimersByTime(TAB_GROUP_EDIT_DEBOUNCE_MS);
    });
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith("agents", { name: "Bots", color: "red" });

    await fireEvent.press(screen.getByLabelText("Green"));
    await fireEvent.press(screen.getByText("Done"));
    expect(props.onUpdate).toHaveBeenLastCalledWith("agents", { color: "green" });
    expect(props.onDismiss).toHaveBeenCalled();
  });

  it("takes the new group away again on Cancel, unsaved edits and all", async () => {
    jest.useFakeTimers();
    const { props, result } = renderSheet({ mode: "create" });
    const screen = await result;

    await fireEvent.changeText(screen.getByTestId("tab-group-name"), "Gone");
    await fireEvent.press(screen.getByText("Cancel"));
    await act(async () => {
      jest.advanceTimersByTime(TAB_GROUP_EDIT_DEBOUNCE_MS);
    });
    expect(props.onCancel).toHaveBeenCalledWith(agents);
    expect(props.onDismiss).toHaveBeenCalled();
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("opens the picker on Custom, starting from the colour shown, and takes a hex", async () => {
    jest.useFakeTimers();
    const { props, result } = renderSheet();
    const screen = await result;

    expect(screen.queryByTestId("tab-group-color-picker")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Custom"));
    expect(screen.getByTestId("tab-group-color-picker")).toBeTruthy();
    expect(screen.getByLabelText("Custom")).toHaveProp("accessibilityState", { checked: true });
    expect(screen.getByTestId("tab-group-color-picker-hex")).toHaveProp(
      "value",
      lightColors.tabGroup.orange.toLowerCase(),
    );

    await fireEvent.changeText(screen.getByTestId("tab-group-color-picker-hex"), "#123456");
    await act(async () => {
      jest.advanceTimersByTime(TAB_GROUP_EDIT_DEBOUNCE_MS);
    });
    expect(props.onUpdate).toHaveBeenLastCalledWith("agents", { color: "#123456" });
  });

  it("opens straight on the picker for a group already in a custom colour", async () => {
    const { result } = renderSheet({ group: { ...agents, color: "#1a2b3c" } });
    const screen = await result;
    expect(screen.getByTestId("tab-group-color-picker-hex")).toHaveProp("value", "#1a2b3c");
  });

  it("manages: a new tab in the group, collapse, and ungroup", async () => {
    const { props, result } = renderSheet();
    const screen = await result;

    expect(screen.getByText("Manage tab group")).toBeTruthy();
    expect(screen.queryByText("Cancel")).toBeNull();
    await fireEvent.press(screen.getByText("New tab in group"));
    expect(props.onNewTab).toHaveBeenCalledWith(agents);
    await fireEvent.press(screen.getByText("Collapse group"));
    expect(props.onToggleCollapsed).toHaveBeenCalledWith(agents);
    await fireEvent.press(screen.getByText("Ungroup tabs"));
    expect(props.onUngroup).toHaveBeenCalledWith(agents);
    expect(props.onDismiss).toHaveBeenCalledTimes(3);
  });

  it("offers Expand for a collapsed group and no new tab past the ceiling", async () => {
    const { props, result } = renderSheet({
      group: { ...agents, collapsed: true },
      canAddTab: false,
    });
    const screen = await result;

    expect(screen.getByText("Expand group")).toBeTruthy();
    const newTab = screen.getByTestId("tab-group-new-tab");
    expect(newTab).toBeDisabled();
    expect(screen.getByText("A workspace can have up to 8 tabs")).toBeTruthy();
    await fireEvent.press(newTab);
    expect(props.onNewTab).not.toHaveBeenCalled();
  });

  it("shows nothing without a group", async () => {
    const { result } = renderSheet({ group: null });
    const screen = await result;
    expect(screen.queryByTestId("sheet")).toBeNull();
  });
});
