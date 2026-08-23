import { fireEvent, render } from "@testing-library/react-native";

import { TAB_CONNECTED_HEIGHT, TAB_WIDTH } from "@/components/workspace-detail/draggable-tab";
import { TabStrip } from "@/components/workspace-detail/tab-strip";
import { ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

import { makeSession, makeTab } from "./fixtures";

describe("TabStrip", () => {
  it("hides close for the sole tab and shows a separate 44pt close target for every closable tab", async () => {
    const oneTab = await render(
      <TabStrip
        activeIndex={0}
        canAdd
        onActions={jest.fn()}
        onAdd={jest.fn()}
        onClose={jest.fn()}
        onReorder={jest.fn()}
        onSelect={jest.fn()}
        sessionsById={new Map()}
        tabs={[makeTab("main")]}
      />,
      { wrapper: ThemeProvider },
    );
    expect(oneTab.queryByLabelText("Close main")).toBeNull();
    await oneTab.unmount();

    const onClose = jest.fn();
    const onSelect = jest.fn();
    const screen = await render(
      <TabStrip
        activeIndex={0}
        canAdd
        onActions={jest.fn()}
        onAdd={jest.fn()}
        onClose={onClose}
        onReorder={jest.fn()}
        onSelect={onSelect}
        sessionsById={new Map()}
        tabs={[makeTab("main"), makeTab("tests")]}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByLabelText("Close main")).toHaveStyle({
      height: sizing.tab.actionTarget,
      width: sizing.tab.actionTarget,
    });
    expect(screen.getByTestId("close-tab-plate-main")).toHaveStyle({
      height: sizing.tab.closePlate,
      width: sizing.tab.closePlate,
    });
    expect(screen.getByLabelText("Close tests")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Close tests"));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ id: "tests" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses tokenized filled tabs and connects populated active content with concave flares", async () => {
    const screen = await render(
      <TabStrip
        activeIndex={0}
        canAdd
        onActions={jest.fn()}
        onAdd={jest.fn()}
        onClose={jest.fn()}
        onReorder={jest.fn()}
        onSelect={jest.fn()}
        sessionsById={new Map()}
        tabs={[
          makeTab("main", [{ session_id: "one", x: 0, y: 0, w: 24, h: 24 }]),
          makeTab("tests"),
        ]}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByTestId("workspace-tab-main")).toHaveStyle({ width: TAB_WIDTH });
    expect(TAB_WIDTH).toBe(sizing.tab.minWidth);
    expect(screen.getByTestId("workspace-tab-strip-frame")).toHaveStyle({
      height: sizing.tab.stripHeight,
      marginBottom: -sizing.tab.connectionOverlap,
    });
    expect(screen.getByTestId("workspace-tab-surface-main")).toHaveStyle({
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
      height: TAB_CONNECTED_HEIGHT,
      paddingBottom: sizing.tab.connectionOverlap,
    });
    expect(screen.getByTestId("workspace-tab-surface-tests")).toHaveStyle({
      height: sizing.tab.visualHeight,
    });
    expect(screen.getByTestId("tab-connection-left-main")).toHaveStyle({
      height: sizing.tab.connectionRadius,
      left: -sizing.tab.connectionRadius,
      width: sizing.tab.connectionRadius,
    });
    expect(screen.getByTestId("tab-connection-right-main")).toHaveStyle({
      height: sizing.tab.connectionRadius,
      right: -sizing.tab.connectionRadius,
      width: sizing.tab.connectionRadius,
    });
    expect(screen.queryByTestId("tab-connection-left-tests")).toBeNull();
  });

  it("centres the attention count in its plate and beside the tab label", async () => {
    const waitingOne = makeSession({ id: "waiting-one", activity_state: "waiting" });
    const waitingTwo = makeSession({ id: "waiting-two", activity_state: "waiting" });
    const screen = await render(
      <TabStrip
        activeIndex={0}
        canAdd
        onActions={jest.fn()}
        onAdd={jest.fn()}
        onClose={jest.fn()}
        onReorder={jest.fn()}
        onSelect={jest.fn()}
        sessionsById={
          new Map([
            [waitingOne.id, waitingOne],
            [waitingTwo.id, waitingTwo],
          ])
        }
        tabs={[
          makeTab("main", [
            { session_id: waitingOne.id, x: 0, y: 0, w: 12, h: 24 },
            { session_id: waitingTwo.id, x: 12, y: 0, w: 12, h: 24 },
          ]),
          makeTab("tests"),
        ]}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByTestId("tab-attention-main-count")).toHaveTextContent("2");
    expect(screen.getByTestId("tab-attention-main")).toHaveStyle({
      alignItems: "center",
      alignSelf: "center",
      justifyContent: "center",
    });
    expect(screen.getByTestId("tab-attention-main-count")).toHaveStyle({
      alignSelf: "center",
      height: sizing.tab.closePlate,
      justifyContent: "center",
      minWidth: sizing.tab.closePlate,
      paddingHorizontal: sizing.space.tight,
      paddingVertical: 0,
    });
    expect(screen.getByTestId("tab-attention-main-numeral")).toHaveStyle({
      fontVariant: ["tabular-nums"],
      includeFontPadding: false,
      lineHeight: sizing.type.micro.lineHeight,
      textAlign: "center",
      textAlignVertical: "center",
    });
    expect(screen.getByTestId("workspace-tab-surface-main")).toHaveStyle({
      alignItems: "center",
      gap: sizing.tab.labelGap,
    });
    expect(screen.getByLabelText("main, 2 sessions awaiting input")).toBeTruthy();
  });

  it("keeps adjacent reorder actions as an accessible drag fallback", async () => {
    const onReorder = jest.fn();
    const screen = await render(
      <TabStrip
        activeIndex={0}
        canAdd
        onActions={jest.fn()}
        onAdd={jest.fn()}
        onClose={jest.fn()}
        onReorder={onReorder}
        onSelect={jest.fn()}
        sessionsById={new Map()}
        tabs={[makeTab("main"), makeTab("tests")]}
      />,
      { wrapper: ThemeProvider },
    );

    await fireEvent(screen.getByLabelText("main"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onReorder).toHaveBeenCalledWith("main", 1);
  });
});
