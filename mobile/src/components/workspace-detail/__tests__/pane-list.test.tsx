import { fireEvent, render } from "@testing-library/react-native";
import { type StyleProp, StyleSheet, type ViewStyle } from "react-native";

import { PaneList } from "@/components/workspace-detail/pane-list";
import { TabStrip } from "@/components/workspace-detail/tab-strip";
import { canAddTab } from "@/data/layout/tabs";
import { canAddTile } from "@/data/layout/tiles";
import type { Tile } from "@/data/types/layout";
import { ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

import { makeHost, makeTab } from "./fixtures";

interface CapturedRefreshControl {
  props: { onRefresh?: () => void; refreshing?: boolean };
}

const mockRefreshControls: CapturedRefreshControl[] = [];

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
    refreshControl?: React.ReactElement;
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
      refreshControl,
      testID,
    }: MockFlashListProps<Item>) => {
      // React Native's own jest mock renders RefreshControl without its props,
      // so the pull is asserted on the element the list was handed.
      if (refreshControl) mockRefreshControls.push(refreshControl as CapturedRefreshControl);
      return React.createElement(
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
      );
    },
  };
});

function latestRefreshControl(): CapturedRefreshControl["props"] {
  const control = mockRefreshControls[mockRefreshControls.length - 1];
  if (!control) throw new Error("The pane list rendered no refresh control.");
  return control.props;
}

describe("workspace tab pane lists", () => {
  beforeEach(() => {
    mockRefreshControls.length = 0;
  });

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
        onOpenFiles={onOpenFiles}
        onOpenTerminal={jest.fn()}
        onPaneActions={jest.fn()}
        onRefresh={jest.fn()}
        refreshing={false}
        sessionsById={new Map()}
        tab={makeTab("main", [tile])}
        transports={{}}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByText("Files — dev")).toBeTruthy();
    expect(screen.getByText("office-mac")).toBeTruthy();
    expect(screen.queryByText("office-mac · /Users/spawn/dev")).toBeNull();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByTestId("pane-list-main")).toHaveStyle({
      paddingTop: sizing.space.cluster,
    });
    expect(
      StyleSheet.flatten(screen.getByTestId("pane-list-main").props["style"]).paddingHorizontal,
    ).toBeUndefined();
    // The swipe layer was removed in round 7 — move and remove live in the ...
    // menu — so the row's own frame is what carries the transparent ground.
    expect(screen.queryByTestId("files-swipe-files-1-content")).toBeNull();
    expect(screen.getByTestId("files-row-files-1")).toBeTruthy();
    const row = screen.getByLabelText("Files — dev, office-mac");
    expect(row).toHaveStyle({
      minHeight: sizing.listRow.regular,
      paddingHorizontal: sizing.listRow.horizontalPadding,
      paddingVertical: sizing.listRow.verticalPadding,
    });
    fireEvent.press(row);
    expect(onOpenFiles).toHaveBeenCalledWith("host-1", "/Users/spawn/dev");
  });

  it("refreshes the tab on a pull, over the whole page rather than the rows alone", async () => {
    const onRefresh = jest.fn();
    const tab = makeTab("main", [
      {
        session_id: "files-1",
        x: 0,
        y: 0,
        w: 24,
        h: 24,
        widget: { kind: "files", host_id: "host-1", path: "/tmp/one" },
      },
    ]);
    const screen = await render(
      <PaneList
        agents={[]}
        canAddPane
        hostsById={new Map([["host-1", makeHost()]])}
        onAddPane={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={jest.fn()}
        onPaneActions={jest.fn()}
        onRefresh={onRefresh}
        refreshing={false}
        sessionsById={new Map()}
        tab={tab}
        transports={{}}
      />,
      { wrapper: ThemeProvider },
    );

    latestRefreshControl().onRefresh?.();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // One pane leaves the rest of the tab empty, and content that stops under
    // the last row takes the pull gesture with it.
    expect(StyleSheet.flatten(screen.getByTestId("pane-list-main").props["style"]).flexGrow).toBe(
      1,
    );
  });

  it("keeps an empty tab pullable and spins only while the pull is served", async () => {
    const screen = await render(
      <PaneList
        agents={[]}
        canAddPane
        hostsById={new Map()}
        onAddPane={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={jest.fn()}
        onPaneActions={jest.fn()}
        onRefresh={jest.fn()}
        refreshing
        sessionsById={new Map()}
        tab={makeTab("main")}
        transports={{}}
      />,
      { wrapper: ThemeProvider },
    );

    // The empty tab is pullable too: the control lives on the list, not on a row.
    expect(screen.getByText("Open your first window")).toBeTruthy();
    expect(latestRefreshControl().refreshing).toBe(true);
  });

  it("joins full-bleed pane rows and closes the list under the last one", async () => {
    const tiles: Tile[] = ["first", "second"].map((id, index) => ({
      session_id: id,
      x: index,
      y: 0,
      w: 12,
      h: 24,
      widget: { kind: "files", host_id: "host-1", path: `/tmp/${id}` },
    }));
    const screen = await render(
      <PaneList
        agents={[]}
        canAddPane
        hostsById={new Map([["host-1", makeHost()]])}
        onAddPane={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={jest.fn()}
        onPaneActions={jest.fn()}
        onRefresh={jest.fn()}
        refreshing={false}
        sessionsById={new Map()}
        tab={makeTab("main", tiles)}
        transports={{}}
      />,
      { wrapper: ThemeProvider },
    );

    // One between the two rows, and one under the last of them: a list that
    // stopped mid-air read as though the panes had been cut off.
    expect(screen.getAllByTestId("list-separator")).toHaveLength(2);
  });

  it("disables add-tab at the eight-tab ceiling", async () => {
    const tabs = Array.from({ length: 8 }, (_, index) => makeTab(`tab-${index + 1}`));
    const layout = { version: 3 as const, active_tab: tabs[0]?.id ?? null, tabs };
    const screen = await render(
      <TabStrip
        activeIndex={0}
        canAdd={canAddTab(layout)}
        onActions={jest.fn()}
        onAdd={jest.fn()}
        onClose={jest.fn()}
        onReorder={jest.fn()}
        onSelect={jest.fn()}
        sessionsById={new Map()}
        tabs={tabs}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByTestId("add-tab-button")).toBeDisabled();
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
        onOpenFiles={jest.fn()}
        onOpenTerminal={jest.fn()}
        onPaneActions={jest.fn()}
        onRefresh={jest.fn()}
        refreshing={false}
        sessionsById={new Map()}
        tab={tab}
        transports={{}}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByLabelText("Add terminal or files")).toBeDisabled();
    expect(screen.getByText("This tab is full. A tab can contain up to 16 panes.")).toBeTruthy();
  });

  it("renders an unavailable pane through the regular full-bleed row primitive", async () => {
    const screen = await render(
      <PaneList
        agents={[]}
        canAddPane
        hostsById={new Map()}
        onAddPane={jest.fn()}
        onOpenFiles={jest.fn()}
        onOpenTerminal={jest.fn()}
        onPaneActions={jest.fn()}
        onRefresh={jest.fn()}
        refreshing={false}
        sessionsById={new Map()}
        tab={makeTab("main", [{ session_id: "missing", x: 0, y: 0, w: 24, h: 24 }])}
        transports={{}}
      />,
      { wrapper: ThemeProvider },
    );

    expect(screen.getByLabelText("Session unavailable, Refresh or remove this pane.")).toHaveStyle({
      minHeight: sizing.listRow.regular,
    });
  });
});
