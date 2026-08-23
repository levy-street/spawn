import { act, fireEvent, render } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { StyleSheet } from "react-native";

import { SearchField } from "@/components/ui/search-field";
import { spacing, ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

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

  test("centres text and leaves tokenized clearance after the search icon", async () => {
    const screen = await render(<SearchField testID="search" />, { wrapper });
    const inputStyle = StyleSheet.flatten(screen.getByTestId("search").props["style"]);

    expect(screen.getByTestId("search")).toHaveStyle({
      paddingLeft: spacing[2],
      paddingVertical: spacing[0],
      textAlignVertical: "center",
    });
    // A lineHeight lays iOS single-line text out from the top of the content box,
    // which parked the query below the field's optical centre.
    expect(inputStyle.lineHeight).toBeUndefined();
  });

  test("stands at the taller search height", async () => {
    const screen = await render(<SearchField testID="search" />, { wrapper });
    const container = screen.getByTestId("search").parent;

    expect(StyleSheet.flatten(container?.props["style"]).height).toBe(sizing.control.searchField);
  });
});
