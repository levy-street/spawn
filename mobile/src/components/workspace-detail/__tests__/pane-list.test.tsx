import { fireEvent, render } from "@testing-library/react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { makeMutable } from "react-native-reanimated";

import { PaneList } from "@/components/workspace-detail/pane-list";
import { TabStrip } from "@/components/workspace-detail/tab-strip";
import { canAddTab } from "@/data/layout/tabs";
import { canAddTile } from "@/data/layout/tiles";
import type { Tile } from "@/data/types/layout";
import { chrome, radii, spacing, specialSpace, ThemeProvider } from "@/theme";

import { makeHost, makeTab } from "./fixtures";

jest.mock("@shopify/flash-list", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");

  interface MockFlashListProps<Item> {
    data?: readonly Item[];
    renderItem: (input: { item: Item; index: number }) => React.ReactNode;
    keyExtractor?: (item: Item, index: number) => string;
    ListEmptyComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    ItemSeparatorComponent?: React.ComponentType;
    contentContainerStyle?: StyleProp<ViewStyle>;
    testID?: string;
  }

  return {
    FlashList: <Item,>({
      data = [],
      renderItem,
      keyExtractor,
      ListEmptyComponent,
      ListFooterComponent,
      ItemSeparatorComponent,
      contentContainerStyle,
      testID,
    }: MockFlashListProps<Item>) =>
      React.createElement(
        View,
        { style: contentContainerStyle, testID },
        data.length === 0 ? ListEmptyComponent : null,
        ...data.flatMap((item, index) => [
          React.createElement(
            React.Fragment,
            { key: keyExtractor?.(item, index) ?? String(index) },
            renderItem({ item, index }),
          ),
          index < data.length - 1 && ItemSeparatorComponent
            ? React.createElement(ItemSeparatorComponent, { key: `separator-${index}` })
            : null,
        ]),
        ListFooterComponent,
      ),
  };
});

describe("workspace tab pane lists", () => {
  it("renders a files widget and routes its host and path on press", async () => {
    const onOpenFiles = jest.fn();
    const tile: Tile = {
      session_id: "files-1",
      x: 0,
      y: 0,
      w: 24,
      h: 24,
      widget: { kind: "files", host_id: "host-1", path: "/Users/spawn/dev" },
    };
    const screen = await render(
      <PaneList
        agents={[]}
        canAddPane
        hostsById={new Map([["host-1", makeHost()]])}
        onAddPane={jest.fn()}
        onMovePane={jest.fn()}
        onOpenFiles={onOpenFiles}
        onOpenTerminal={jest.fn()}
        onPaneActions={jest.fn()}
        onRemovePane={jest.fn()}
        onRenameSession={jest.fn()}
        sessionsById={new Map()}
        tab={makeTab("main", [tile])}
        transports={{}}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByText("Files — dev")).toBeTruthy();
    expect(screen.getByText("office-mac · /Users/spawn/dev")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByTestId("pane-list-main")).toHaveStyle({
      padding: specialSpace.paneHalfGap,
    });
    expect(screen.getByTestId("files-row-files-1")).toHaveStyle({
      borderRadius: radii.md,
      minHeight: spacing[14],
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
    });
    fireEvent.press(screen.getByTestId("files-row-files-1"));
    expect(onOpenFiles).toHaveBeenCalledWith("host-1", "/Users/spawn/dev");
  });

  it("disables add-tab at the eight-tab ceiling", async () => {
    const tabs = Array.from({ length: 8 }, (_, index) => makeTab(`tab-${index + 1}`));
    const layout = { version: 3 as const, active_tab: tabs[0]?.id ?? null, tabs };
    const screen = await render(
      <TabStrip
        activeIndex={0}
        canAdd={canAddTab(layout)}
        dragProgress={makeMutable(0)}
        onActions={jest.fn()}
        onAdd={jest.fn()}
        onSelect={jest.fn()}
        tabs={tabs}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByTestId("add-tab-button")).toBeDisabled();
    expect(screen.getByTestId("workspace-tab-tab-1")).toHaveStyle({
      height: chrome.touchTarget,
    });
    expect(screen.getByTestId("workspace-tab-surface-tab-1")).toHaveStyle({
      height: spacing[8],
    });
  });

  it("disables add-pane at the sixteen-tile ceiling", async () => {
    const tiles: Tile[] = Array.from({ length: 16 }, (_, index) => ({
      session_id: `files-${index}`,
      x: index,
      y: 0,
      w: 4,
      h: 4,
      widget: { kind: "files", host_id: "host-1", path: `/tmp/${index}` },
    }));
    const tab = makeTab("full", tiles);
    const screen = await render(
      <PaneList
        agents={[]}
        canAddPane={canAddTile(tab.layout)}
        hostsById={new Map([["host-1", makeHost()]])}
        onAddPane={jest.fn()}
        onMovePane={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={jest.fn()}
        onPaneActions={jest.fn()}
        onRemovePane={jest.fn()}
        onRenameSession={jest.fn()}
        sessionsById={new Map()}
        tab={tab}
        transports={{}}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByLabelText("Add")).toBeDisabled();
  });
});
