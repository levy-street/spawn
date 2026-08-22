import { fireEvent, render } from "@testing-library/react-native";
import { Text, View } from "react-native";
import { makeMutable } from "react-native-reanimated";

import { TabPager } from "@/components/gestures/tab-pager";
import { TabStrip } from "@/components/workspace-detail/tab-strip";
import { haptics } from "@/lib/haptics";
import { ThemeProvider } from "@/theme";

import { makeTab } from "./fixtures";

jest.mock("@/lib/haptics", () => ({
  haptics: {
    selection: jest.fn(),
  },
}));

describe("workspace tab pager", () => {
  beforeEach(() => jest.clearAllMocks());

  it("links strip progress continuously and fires one haptic on committed change", async () => {
    const tabs = [makeTab("main"), makeTab("tests"), makeTab("server")];
    const progress = makeMutable(0);
    const onPageChange = jest.fn();
    const screen = await render(
      <View style={{ flex: 1 }}>
        <TabStrip
          activeIndex={0}
          canAdd
          onActions={jest.fn()}
          onAdd={jest.fn()}
          onClose={jest.fn()}
          onReorder={jest.fn()}
          onSelect={jest.fn()}
          tabs={tabs}
        />
        <TabPager
          onDragProgress={progress}
          onPageChange={onPageChange}
          pages={tabs}
          renderPage={(tab) => <Text>{tab.name}</Text>}
          testID="detail-pager"
        />
      </View>,
      { wrapper: ThemeProvider },
    );

    await fireEvent(screen.getByTestId("detail-pager"), "pageScroll", {
      eventName: "onPageScroll",
      nativeEvent: { position: 0, offset: 0.4 },
      position: 0,
      offset: 0.4,
    });
    expect(progress.value).toBe(0.4);

    await fireEvent(screen.getByTestId("detail-pager"), "pageSelected", {
      nativeEvent: { position: 1 },
    });
    await fireEvent(screen.getByTestId("detail-pager"), "pageSelected", {
      nativeEvent: { position: 1 },
    });

    expect(onPageChange).toHaveBeenCalledTimes(1);
    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });
});
