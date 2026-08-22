import { fireEvent, render } from "@testing-library/react-native";

import { TAB_CONNECTED_HEIGHT, TAB_WIDTH } from "@/components/workspace-detail/draggable-tab";
import { TabStrip } from "@/components/workspace-detail/tab-strip";
import { spacing, ThemeProvider } from "@/theme";

import { makeTab } from "./fixtures";

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
        tabs={[makeTab("main"), makeTab("tests")]}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByLabelText("Close main")).toHaveStyle({
      height: spacing[11],
      width: spacing[11],
    });
    expect(screen.getByLabelText("Close tests")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Close tests"));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ id: "tests" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses separate 160pt filled tabs and connects the active tab to populated content", async () => {
    const screen = await render(
      <TabStrip
        activeIndex={0}
        canAdd
        onActions={jest.fn()}
        onAdd={jest.fn()}
        onClose={jest.fn()}
        onReorder={jest.fn()}
        onSelect={jest.fn()}
        tabs={[
          makeTab("main", [{ session_id: "one", x: 0, y: 0, w: 24, h: 24 }]),
          makeTab("tests"),
        ]}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByTestId("workspace-tab-main")).toHaveStyle({ width: TAB_WIDTH });
    expect(screen.getByTestId("workspace-tab-surface-main")).toHaveStyle({
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
      height: TAB_CONNECTED_HEIGHT,
    });
    expect(screen.getByTestId("workspace-tab-surface-tests")).toHaveStyle({
      height: spacing[10],
    });
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
