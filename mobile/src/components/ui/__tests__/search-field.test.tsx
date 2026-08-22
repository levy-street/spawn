import { act, fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import { SearchField } from "@/components/ui/search-field";
import { ThemeProvider } from "@/theme";

jest.mock(
  "@/components/ui/icon",
  () => ({
    Icon: () => null,
  }),
  { virtual: true },
);

function wrapper({ children }: PropsWithChildren) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe("SearchField", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("debounces changes using the configured interval", async () => {
    const onDebouncedChange = jest.fn();
    const screen = await render(
      <SearchField debounceMs={300} onDebouncedChange={onDebouncedChange} testID="search" />,
      { wrapper },
    );

    await fireEvent.changeText(screen.getByTestId("search"), "wor");
    await fireEvent.changeText(screen.getByTestId("search"), "workspace");

    await act(() => jest.advanceTimersByTime(299));
    expect(onDebouncedChange).not.toHaveBeenCalled();
    await act(() => jest.advanceTimersByTime(1));
    expect(onDebouncedChange).toHaveBeenCalledTimes(1);
    expect(onDebouncedChange).toHaveBeenCalledWith("workspace");
  });

  test("shows a clear action only when non-empty and clears both callbacks", async () => {
    const onChangeText = jest.fn();
    const onDebouncedChange = jest.fn();
    const screen = await render(
      <SearchField
        onChangeText={onChangeText}
        onDebouncedChange={onDebouncedChange}
        testID="search"
      />,
      { wrapper },
    );

    expect(screen.queryByLabelText("Clear search")).not.toBeOnTheScreen();
    await fireEvent.changeText(screen.getByTestId("search"), "host");
    await fireEvent.press(screen.getByLabelText("Clear search"));

    expect(onChangeText).toHaveBeenLastCalledWith("");
    expect(screen.queryByLabelText("Clear search")).not.toBeOnTheScreen();
    await act(() => jest.advanceTimersByTime(250));
    expect(onDebouncedChange).toHaveBeenLastCalledWith("");
  });
});
