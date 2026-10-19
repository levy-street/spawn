import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { State } from "react-native-gesture-handler";
import { fireGestureHandler, getByGestureTestId } from "react-native-gesture-handler/jest-utils";

import { ColorPicker } from "@/components/ui/color-picker";
import { ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

async function renderPicker(value = "#ff0000") {
  const onChange = jest.fn();
  const onActiveChange = jest.fn();
  const screen = await render(
    <ColorPicker onActiveChange={onActiveChange} onChange={onChange} value={value} />,
    { wrapper: ThemeProvider },
  );
  return { screen, onChange, onActiveChange };
}

function action(actionName: string) {
  return { nativeEvent: { actionName } };
}

describe("ColorPicker", () => {
  it("is two adjustable controls that say where they stand", async () => {
    const { screen } = await renderPicker("#ff0000");
    const square = screen.getByTestId("color-picker-square");
    const hue = screen.getByTestId("color-picker-hue");

    expect(square).toHaveProp("accessibilityRole", "adjustable");
    expect(square).toHaveProp("accessibilityValue", {
      text: "Saturation 100%, brightness 100%",
    });
    expect(hue).toHaveProp("accessibilityRole", "adjustable");
    expect(hue).toHaveProp("accessibilityValue", { text: "0 degrees" });
    expect(square.props["accessibilityActions"].map((item: { name: string }) => item.name)).toEqual(
      ["increment", "decrement", "moreSaturated", "lessSaturated"],
    );
  });

  it("steps brightness, saturation and hue through the accessible actions", async () => {
    const { screen, onChange } = await renderPicker("#ff0000");

    await fireEvent(screen.getByTestId("color-picker-square"), "accessibilityAction", {
      ...action("decrement"),
    });
    expect(onChange).toHaveBeenLastCalledWith("#f20000");
    expect(screen.getByTestId("color-picker-square")).toHaveProp("accessibilityValue", {
      text: "Saturation 100%, brightness 95%",
    });

    await fireEvent(screen.getByTestId("color-picker-square"), "accessibilityAction", {
      ...action("increment"),
    });
    expect(onChange).toHaveBeenLastCalledWith("#ff0000");

    await fireEvent(
      screen.getByTestId("color-picker-square"),
      "accessibilityAction",
      action("lessSaturated"),
    );
    expect(onChange).toHaveBeenLastCalledWith("#ff0d0d");

    await fireEvent(
      screen.getByTestId("color-picker-square"),
      "accessibilityAction",
      action("moreSaturated"),
    );
    expect(onChange).toHaveBeenLastCalledWith("#ff0000");

    await fireEvent(screen.getByTestId("color-picker-hue"), "accessibilityAction", {
      ...action("increment"),
    });
    expect(onChange).toHaveBeenLastCalledWith("#ff2a00");
    expect(screen.getByTestId("color-picker-hue")).toHaveProp("accessibilityValue", {
      text: "10 degrees",
    });

    // Hue wraps rather than stopping at red.
    await fireEvent(screen.getByTestId("color-picker-hue"), "accessibilityAction", {
      ...action("decrement"),
    });
    await fireEvent(screen.getByTestId("color-picker-hue"), "accessibilityAction", {
      ...action("decrement"),
    });
    expect(screen.getByTestId("color-picker-hue")).toHaveProp("accessibilityValue", {
      text: "350 degrees",
    });
  });

  it("takes a typed hex, short or long and in any case, and ignores what is not one", async () => {
    const { screen, onChange } = await renderPicker("#ff0000");
    const input = screen.getByTestId("color-picker-hex");

    await fireEvent.changeText(input, "#0F0");
    expect(onChange).toHaveBeenLastCalledWith("#00ff00");
    expect(screen.getByTestId("color-picker-hue")).toHaveProp("accessibilityValue", {
      text: "120 degrees",
    });

    onChange.mockClear();
    await fireEvent.changeText(input, "#12");
    await fireEvent.changeText(input, "teal");
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveProp("value", "teal");

    // Leaving the field puts back the colour actually chosen.
    await fireEvent(input, "blur");
    expect(screen.getByTestId("color-picker-hex")).toHaveProp("value", "#00ff00");

    await fireEvent.changeText(screen.getByTestId("color-picker-hex"), "#1A2B3C");
    expect(onChange).toHaveBeenLastCalledWith("#1a2b3c");
  });

  it("keeps the chosen hue when a grey is typed", async () => {
    const { screen } = await renderPicker("#00ff00");
    await fireEvent.changeText(screen.getByTestId("color-picker-hex"), "#808080");
    expect(screen.getByTestId("color-picker-hue")).toHaveProp("accessibilityValue", {
      text: "120 degrees",
    });
  });

  it("follows a value changed from outside", async () => {
    const onChange = jest.fn();
    const screen = await render(<ColorPicker onChange={onChange} value="#ff0000" />, {
      wrapper: ThemeProvider,
    });
    await screen.rerender(<ColorPicker onChange={onChange} value="#0000ff" />);
    expect(screen.getByTestId("color-picker-hex")).toHaveProp("value", "#0000ff");
    expect(screen.getByTestId("color-picker-hue")).toHaveProp("accessibilityValue", {
      text: "240 degrees",
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sets saturation and brightness from where the square is touched", async () => {
    const { screen, onChange, onActiveChange } = await renderPicker("#ff0000");
    await fireEvent(screen.getByTestId("color-picker"), "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 300 } },
    });

    await act(async () => {
      fireGestureHandler(getByGestureTestId("color-picker-square-pan"), [
        { state: State.BEGAN, x: 100, y: 0 },
        { state: State.ACTIVE, x: 150, y: 0 },
        { state: State.ACTIVE, x: 200, y: sizing.colorPicker.squareHeight / 2 },
        { state: State.END, x: 200, y: sizing.colorPicker.squareHeight / 2 },
      ]);
    });

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("#800000"));
    expect(onActiveChange).toHaveBeenCalledWith(true);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId("color-picker-square-thumb")).toBeTruthy();
  });

  it("sets the hue from where the bar is touched", async () => {
    const { screen, onChange } = await renderPicker("#ff0000");
    await fireEvent(screen.getByTestId("color-picker"), "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 300 } },
    });

    await act(async () => {
      fireGestureHandler(getByGestureTestId("color-picker-hue-pan"), [
        { state: State.BEGAN, x: 240 },
        { state: State.ACTIVE, x: 240 },
        { state: State.END, x: 240 },
      ]);
    });

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("#0000ff"));
  });
});
