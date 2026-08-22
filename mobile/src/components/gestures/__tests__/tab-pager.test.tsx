import { fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";
import { makeMutable } from "react-native-reanimated";

import { TabPager } from "@/components/gestures/tab-pager";
import { haptics } from "@/lib/haptics";

jest.mock("@/lib/haptics", () => ({
  haptics: {
    selection: jest.fn(),
  },
}));

const PAGES = ["one", "two", "three", "four"] as const;

describe("TabPager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders only the active page and its lazy neighbours", async () => {
    const screen = await render(
      <TabPager initialPage={1} pages={PAGES} renderPage={(page) => <Text>{page}</Text>} />,
    );

    expect(screen.queryByText("one")).toBeTruthy();
    expect(screen.queryByText("two")).toBeTruthy();
    expect(screen.queryByText("three")).toBeTruthy();
    expect(screen.queryByText("four")).toBeNull();
  });

  it("respects a zero-sized lazy window", async () => {
    const screen = await render(
      <TabPager
        initialPage={2}
        lazyWindow={0}
        pages={PAGES}
        renderPage={(page) => <Text>{page}</Text>}
      />,
    );

    expect(screen.queryByText("two")).toBeNull();
    expect(screen.getByText("three")).toBeTruthy();
    expect(screen.queryByText("four")).toBeNull();
  });

  it("commits a page change and fires one selection haptic", async () => {
    const onPageChange = jest.fn();
    const screen = await render(
      <TabPager
        onPageChange={onPageChange}
        pages={PAGES}
        renderPage={(page) => <Text>{page}</Text>}
      />,
    );

    await fireEvent(screen.getByTestId("tab-pager"), "pageSelected", {
      nativeEvent: { position: 1 },
    });
    await fireEvent(screen.getByTestId("tab-pager"), "pageSelected", {
      nativeEvent: { position: 1 },
    });

    expect(onPageChange).toHaveBeenCalledTimes(1);
    expect(onPageChange).toHaveBeenCalledWith(1);
    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });

  it("follows controlled page changes", async () => {
    const renderPage = (page: (typeof PAGES)[number]) => <Text>{page}</Text>;
    const screen = await render(
      <TabPager lazyWindow={0} page={0} pages={PAGES} renderPage={renderPage} />,
    );

    expect(screen.getByText("one")).toBeTruthy();
    await screen.rerender(
      <TabPager lazyWindow={0} page={2} pages={PAGES} renderPage={renderPage} />,
    );

    expect(screen.queryByText("one")).toBeNull();
    expect(screen.getByText("three")).toBeTruthy();
  });

  it("publishes continuous drag progress into a shared value", async () => {
    const dragProgress = makeMutable(0);
    const screen = await render(
      <TabPager
        onDragProgress={dragProgress}
        pages={PAGES}
        renderPage={(page) => <Text>{page}</Text>}
      />,
    );

    await fireEvent(screen.getByTestId("tab-pager"), "pageScroll", {
      eventName: "onPageScroll",
      nativeEvent: { position: 1, offset: 0.25 },
      position: 1,
      offset: 0.25,
    });

    expect(dragProgress.value).toBe(1.25);
  });

  it("renders an empty pager without invoking the page renderer", async () => {
    const renderPage = jest.fn(() => <Text>unexpected</Text>);
    const screen = await render(<TabPager pages={[]} renderPage={renderPage} />);

    expect(screen.getByTestId("tab-pager")).toBeTruthy();
    expect(renderPage).not.toHaveBeenCalled();
  });
});
