import { fireEvent, render } from "@testing-library/react-native";
import { StyleSheet, View } from "react-native";

import { AppHeader, AppHeaderLeadingProvider } from "@/components/layout/app-header";
import { ThemeProvider } from "@/theme";
import { sizing } from "@/theme/sizing";

jest.mock("react-native-safe-area-context", () => {
  const { createContext } = require("react") as typeof import("react");
  return {
    SafeAreaInsetsContext: createContext({ bottom: 34, left: 0, right: 0, top: 59 }),
  };
});

function renderHeader(node: React.JSX.Element) {
  return render(<ThemeProvider>{node}</ThemeProvider>);
}

describe("AppHeader", () => {
  it("renders its title and optional subtitle", async () => {
    const screen = await renderHeader(<AppHeader subtitle="Connected" title="Workspace" />);

    expect(screen.getByRole("header", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("calls the standard back action", async () => {
    const onBack = jest.fn();
    const screen = await renderHeader(<AppHeader onBack={onBack} title="Files" />);

    await fireEvent.press(screen.getByLabelText("Go back"));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("uses a shell back override for the root of a retained companion tab", async () => {
    const onBack = jest.fn();
    const onBackOverride = jest.fn();
    const screen = await renderHeader(
      <AppHeaderLeadingProvider backOverride={onBackOverride} leading={null}>
        <AppHeader onBack={onBack} title="Host" />
      </AppHeaderLeadingProvider>,
    );

    await fireEvent.press(screen.getByLabelText("Go back"));

    expect(onBackOverride).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("renders a leading control instead of the back chevron", async () => {
    const onBack = jest.fn();
    const screen = await renderHeader(
      <AppHeader leading={<View testID="custom-leading" />} onBack={onBack} title="Settings" />,
    );

    expect(screen.getByTestId("custom-leading")).toBeTruthy();
    expect(screen.queryByLabelText("Go back")).toBeNull();
  });

  it("renders and fires trailing actions", async () => {
    const onRefresh = jest.fn();
    const onSettings = jest.fn();
    const screen = await renderHeader(
      <AppHeader
        actions={[
          { accessibilityLabel: "Refresh", icon: "RefreshCw", onPress: onRefresh },
          { accessibilityLabel: "Settings", icon: "Settings", onPress: onSettings },
        ]}
        title="Hosts"
      />,
    );

    await fireEvent.press(screen.getByLabelText("Refresh"));
    await fireEvent.press(screen.getByLabelText("Settings"));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps screen actions visible beside a declared accessory", async () => {
    const onPress = jest.fn();
    const screen = await renderHeader(
      <AppHeader
        accessory={<View testID="connection-accessory" />}
        actions={[{ accessibilityLabel: "Terminal actions", icon: "Ellipsis", onPress }]}
        title="Terminal"
      />,
    );

    expect(screen.getByTestId("connection-accessory")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Terminal actions"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("drops primary destinations while retaining contextual screen actions", async () => {
    const onCreate = jest.fn();
    const screen = await renderHeader(
      <AppHeader
        actions={[
          { accessibilityLabel: "New workspace", icon: "Plus", onPress: onCreate },
          { accessibilityLabel: "Open hosts", icon: "Server", onPress: jest.fn() },
          { accessibilityLabel: "Open settings", icon: "Settings", onPress: jest.fn() },
        ]}
        title="Workspaces"
      />,
    );

    expect(screen.queryByLabelText("Open hosts")).toBeNull();
    expect(screen.queryByLabelText("Open settings")).toBeNull();
    await fireEvent.press(screen.getByLabelText("New workspace"));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("does not fire a disabled action", async () => {
    const onPress = jest.fn();
    const screen = await renderHeader(
      <AppHeader
        actions={[{ accessibilityLabel: "Unavailable", disabled: true, icon: "Plus", onPress }]}
        title="Workspace"
      />,
    );

    await fireEvent.press(screen.getByLabelText("Unavailable"));

    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Unavailable").props["accessibilityState"]).toMatchObject({
      disabled: true,
    });
  });

  it("reserves equal side slots so changing actions cannot shift the title", async () => {
    const screen = await renderHeader(
      <AppHeader
        actions={[{ accessibilityLabel: "Settings", icon: "Settings", onPress: jest.fn() }]}
        title="Centred"
      />,
    );

    const leading = StyleSheet.flatten(
      screen.getByTestId("app-header-leading-slot").props["style"],
    );
    const trailing = StyleSheet.flatten(
      screen.getByTestId("app-header-trailing-slot").props["style"],
    );

    expect(leading.width).toBe(sizing.appHeader.sideSlot);
    expect(trailing.width).toBe(sizing.appHeader.sideSlot);
  });

  it("keeps the back and trailing action targets square", async () => {
    const screen = await renderHeader(
      <AppHeader
        actions={[{ accessibilityLabel: "Refresh", icon: "RefreshCw", onPress: jest.fn() }]}
        onBack={jest.fn()}
        title="Square controls"
      />,
    );

    for (const control of [screen.getByLabelText("Go back"), screen.getByLabelText("Refresh")]) {
      const style = StyleSheet.flatten(control.props["style"]);
      expect(style.height).toBe(sizing.appHeader.actionTarget);
      expect(style.width).toBe(style.height);
      expect(style.minHeight).toBe(style.height);
      expect(style.minWidth).toBe(style.width);
    }
  });
});
