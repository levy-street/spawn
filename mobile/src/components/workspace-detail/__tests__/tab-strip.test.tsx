import { fireEvent, render } from "@testing-library/react-native";

import { TAB_CONNECTED_HEIGHT, TAB_WIDTH } from "@/components/workspace-detail/draggable-tab";
import { TabStrip } from "@/components/workspace-detail/tab-strip";
import {
  slotDestination,
  stepDestination,
  tabStripModel,
} from "@/components/workspace-detail/tab-strip-model";
import { labelTextColor } from "@/data/color";
import { reorderTab } from "@/data/layout/tabs";
import type { TabGroup } from "@/data/types/layout";
import { lightColors, ThemeProvider } from "@/theme";
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

describe("TabStrip groups", () => {
  const agents: TabGroup = {
    id: "agents",
    name: "Agents",
    color: "orange",
    collapsed: false,
    tab_ids: ["tests", "server"],
  };
  const tabs = [makeTab("main"), makeTab("tests"), makeTab("server"), makeTab("docs")];

  async function renderStrip(
    groups: TabGroup[],
    overrides: Partial<React.ComponentProps<typeof TabStrip>> = {},
  ) {
    return render(
      <TabStrip
        activeIndex={0}
        canAdd
        groups={groups}
        onActions={jest.fn()}
        onAdd={jest.fn()}
        onClose={jest.fn()}
        onReorder={jest.fn()}
        onSelect={jest.fn()}
        sessionsById={new Map()}
        tabs={tabs}
        {...overrides}
      />,
      { wrapper: ThemeProvider },
    );
  }

  it("labels a group before its first tab and rules a line over its tabs", async () => {
    const screen = await renderStrip([agents]);
    const label = screen.getByLabelText("Agents, tab group, 2 tabs");
    expect(label).toHaveProp("accessibilityState", { expanded: true });
    expect(label).toHaveProp("accessibilityRole", "button");
    expect(screen.getByTestId("tab-group-chip-agents")).toHaveStyle({
      backgroundColor: lightColors.tabGroup.orange,
    });
    expect(screen.getByText("Agents")).toHaveStyle({
      color: labelTextColor(lightColors.tabGroup.orange),
    });

    // The label sits between main and the group's first tab.
    const order = screen
      .getAllByTestId(/^(workspace-tab-(main|tests|server|docs)|tab-group-label-agents)$/)
      .map((node) => node.props["testID"] as string);
    expect(order).toEqual([
      "workspace-tab-main",
      "tab-group-label-agents",
      "workspace-tab-tests",
      "workspace-tab-server",
      "workspace-tab-docs",
    ]);

    expect(screen.getByTestId("tab-group-line-tests")).toHaveStyle({
      backgroundColor: lightColors.tabGroup.orange,
      width: TAB_WIDTH + sizing.tab.itemGap,
    });
    expect(screen.getByTestId("tab-group-line-server")).toHaveStyle({ width: TAB_WIDTH });
    expect(screen.queryByTestId("tab-group-line-main")).toBeNull();
  });

  it("toggles on tap, opens the group on a hold, and offers both to assistive tech", async () => {
    const onToggleGroup = jest.fn();
    const onManageGroup = jest.fn();
    const screen = await renderStrip([agents], { onManageGroup, onToggleGroup });
    const label = screen.getByTestId("tab-group-label-agents");

    await fireEvent.press(label);
    expect(onToggleGroup).toHaveBeenCalledWith(agents);
    await fireEvent(label, "longPress");
    expect(onManageGroup).toHaveBeenCalledWith(agents);

    expect(label.props["accessibilityActions"]).toEqual([
      { name: "collapse", label: "Collapse group" },
      { name: "edit", label: "Manage tab group" },
    ]);
    await fireEvent(label, "accessibilityAction", { nativeEvent: { actionName: "collapse" } });
    await fireEvent(label, "accessibilityAction", { nativeEvent: { actionName: "edit" } });
    expect(onToggleGroup).toHaveBeenCalledTimes(2);
    expect(onManageGroup).toHaveBeenCalledTimes(2);
  });

  it("hides a collapsed group's tabs, counts them, and dots the label for their attention", async () => {
    const waiting = makeSession({ id: "waiting", activity_state: "waiting" });
    const screen = await render(
      <TabStrip
        activeIndex={0}
        canAdd
        groups={[{ ...agents, collapsed: true }]}
        onActions={jest.fn()}
        onAdd={jest.fn()}
        onClose={jest.fn()}
        onReorder={jest.fn()}
        onSelect={jest.fn()}
        sessionsById={new Map([[waiting.id, waiting]])}
        tabs={[
          makeTab("main"),
          makeTab("tests", [{ session_id: waiting.id, x: 0, y: 0, w: 24, h: 24 }]),
          makeTab("server"),
          makeTab("docs"),
        ]}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.queryByTestId("workspace-tab-tests")).toBeNull();
    expect(screen.queryByTestId("workspace-tab-server")).toBeNull();
    expect(screen.getByTestId("workspace-tab-docs")).toBeTruthy();
    expect(screen.getByTestId("tab-group-count-agents")).toHaveTextContent("+2");
    expect(screen.getByTestId("tab-group-attention-agents")).toHaveStyle({
      backgroundColor: lightColors.warning,
    });
    const label = screen.getByLabelText("Agents, tab group, 2 tabs, 1 session awaiting input");
    expect(label).toHaveProp("accessibilityState", { expanded: false });
    expect(label.props["accessibilityActions"][0]).toEqual({
      name: "expand",
      label: "Expand group",
    });
  });

  it("keeps a collapsed group's selected tab in view", async () => {
    const screen = await renderStrip([{ ...agents, collapsed: true }], { activeIndex: 2 });
    expect(screen.getByTestId("workspace-tab-server")).toBeTruthy();
    expect(screen.queryByTestId("workspace-tab-tests")).toBeNull();
    expect(screen.getByTestId("tab-group-count-agents")).toHaveTextContent("+1");
    expect(screen.queryByTestId("tab-group-attention-agents")).toBeNull();
  });

  it("gives an unnamed group a compact label read as Unnamed group", async () => {
    const screen = await renderStrip([{ ...agents, name: "", color: "#1a2b3c" }]);
    expect(screen.getByLabelText("Unnamed group, tab group, 2 tabs")).toHaveStyle({
      width: sizing.tab.groupLabelCompactWidth,
    });
    expect(screen.getByTestId("tab-group-chip-agents")).toHaveStyle({
      backgroundColor: "#1a2b3c",
    });
  });

  it("steps a tab past a collapsed group as one place, by the accessible actions", async () => {
    const onReorder = jest.fn();
    const screen = await renderStrip([{ ...agents, collapsed: true }], { onReorder });
    await fireEvent(screen.getByLabelText("docs"), "accessibilityAction", {
      nativeEvent: { actionName: "decrement" },
    });
    expect(onReorder).toHaveBeenCalledWith("docs", 1);
    await fireEvent(screen.getByLabelText("main"), "accessibilityAction", {
      nativeEvent: { actionName: "increment" },
    });
    expect(onReorder).toHaveBeenLastCalledWith("main", 2);
  });
});

describe("tab strip model", () => {
  const tabs = ["a", "b", "c", "d", "e"].map((id) => makeTab(id));
  const group = (overrides: Partial<TabGroup> = {}): TabGroup => ({
    id: "g",
    name: "G",
    color: "blue",
    collapsed: false,
    tab_ids: ["b", "c", "d"],
    ...overrides,
  });
  const step = sizing.tab.minWidth + sizing.tab.itemGap;
  const label = sizing.tab.groupLabelWidth + sizing.tab.itemGap;

  it("lays labels into the row and every tab at a known position", () => {
    const model = tabStripModel(tabs, [group()], 0);
    expect(model.items.map((item) => item.key)).toEqual(["a", "group-g", "b", "c", "d", "e"]);
    expect(model.slots).toEqual([0, 1, 2, 3, 4]);
    expect(model.slotLefts).toEqual([
      0,
      step + label,
      2 * step + label,
      3 * step + label,
      4 * step + label,
    ]);
    expect(model.tabLefts).toEqual(model.slotLefts);
  });

  it("leaves a collapsed group's hidden tabs out of the slots", () => {
    const model = tabStripModel(tabs, [group({ collapsed: true })], 2);
    expect(model.slots).toEqual([0, 2, 4]);
    expect(model.tabLefts).toEqual([0, -1, step + label, -1, 2 * step + label]);
    const labelItem = model.items.find((item) => item.kind === "label");
    expect(labelItem?.kind === "label" ? labelItem.hidden.map((tab) => tab.id) : null).toEqual([
      "b",
      "d",
    ]);
  });

  it("drops beside the tab passed, moving a collapsed group's hidden run as one block", () => {
    const groups = [group({ collapsed: true })];
    const { slots } = tabStripModel(tabs, groups, 2);
    // a carried right past c (which shows the collapsed group) lands after d.
    const toIndex = slotDestination(tabs, groups, slots, 0, 1);
    expect(toIndex).toBe(3);
    const after = reorderTab(
      { version: 3, active_tab: "a", tabs: [...tabs], groups },
      "a",
      toIndex,
    );
    expect(after.tabs.map((tab) => tab.id)).toEqual(["b", "c", "d", "a", "e"]);
    expect(after.groups?.[0]?.tab_ids).toEqual(["b", "c", "d"]);
    // e carried left past c lands before b.
    expect(slotDestination(tabs, groups, slots, 2, 1)).toBe(1);
    // An expanded group is no block: e carried left past d lands between c and d, and joins.
    const open = [group()];
    const openSlots = tabStripModel(tabs, open, 0).slots;
    const joined = reorderTab(
      { version: 3, active_tab: "a", tabs: [...tabs], groups: open },
      "e",
      slotDestination(tabs, open, openSlots, 4, 3),
    );
    expect(joined.tabs.map((tab) => tab.id)).toEqual(["a", "b", "c", "e", "d"]);
    expect(joined.groups?.[0]?.tab_ids).toEqual(["b", "c", "e", "d"]);
  });

  it("steps one place at a time, a collapsed group counting as one", () => {
    const collapsed = [group({ collapsed: true })];
    expect(stepDestination(tabs, collapsed, "e", -1)).toBe(1);
    expect(stepDestination(tabs, collapsed, "a", 1)).toBe(3);
    expect(stepDestination(tabs, collapsed, "c", -1)).toBe(1);
    expect(stepDestination(tabs, collapsed, "c", 1)).toBe(3);
    expect(stepDestination(tabs, collapsed, "a", -1)).toBe(0);
    expect(stepDestination(tabs, collapsed, "e", 1)).toBe(4);
    expect(stepDestination(tabs, [group()], "e", -1)).toBe(3);
  });
});
