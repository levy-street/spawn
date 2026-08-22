import { HeaderHeightContext } from "@react-navigation/elements";
import { render } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { StyleSheet, Text } from "react-native";

import { Screen } from "@/components/layout/screen";
import { ThemeProvider } from "@/theme";

let mockKeyboardVisible = false;

jest.mock("react-native-safe-area-context", () => {
  const { createContext } = require("react") as typeof import("react");
  const insets = { bottom: 34, left: 0, right: 0, top: 59 };
  return {
    SafeAreaInsetsContext: createContext(insets),
    useSafeAreaInsets: () => insets,
  };
});

jest.mock("react-native-keyboard-controller", () => ({
  ...(() => {
    const { View: MockView } = require("react-native") as typeof import("react-native");
    return {
      KeyboardAwareScrollView: ({
        children,
        contentContainerStyle,
        testID,
      }: {
        children: ReactNode;
        contentContainerStyle?: object;
        testID?: string;
      }) => (
        <MockView style={contentContainerStyle} testID={testID}>
          {children}
        </MockView>
      ),
      KeyboardStickyView: ({ children }: { children: ReactNode }) => (
        <MockView>{children}</MockView>
      ),
      useKeyboardState: (selector: (state: { isVisible: boolean }) => boolean) =>
        selector({ isVisible: mockKeyboardVisible }),
    };
  })(),
}));

async function renderScreen(node: ReactNode, headerHeight = 0) {
  return render(
    <ThemeProvider>
      <HeaderHeightContext.Provider value={headerHeight}>{node}</HeaderHeightContext.Provider>
    </ThemeProvider>,
  );
}

describe("Screen", () => {
  beforeEach(() => {
    mockKeyboardVisible = false;
  });

  it("owns the top inset once for a headerless screen", async () => {
    const screen = await renderScreen(
      <Screen padded={false}>
        <Text>Content</Text>
      </Screen>,
    );

    expect(StyleSheet.flatten(screen.getByTestId("screen-content").props["style"])).toMatchObject({
      paddingTop: 59,
    });
  });

  it("does not repeat the top inset below a native header", async () => {
    const screen = await renderScreen(
      <Screen padded={false}>
        <Text>Content</Text>
      </Screen>,
      103,
    );

    expect(StyleSheet.flatten(screen.getByTestId("screen-content").props["style"])).toMatchObject({
      paddingTop: 0,
    });
  });

  it("moves the pinned footer with the keyboard and changes its safe-bottom policy", async () => {
    const view = await renderScreen(
      <Screen footer={<Text>Continue</Text>} scroll>
        <Text>Form</Text>
      </Screen>,
    );

    expect(StyleSheet.flatten(view.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 34,
    });

    mockKeyboardVisible = true;
    await view.rerender(
      <ThemeProvider>
        <HeaderHeightContext.Provider value={0}>
          <Screen footer={<Text>Continue</Text>} scroll>
            <Text>Form</Text>
          </Screen>
        </HeaderHeightContext.Provider>
      </ThemeProvider>,
    );

    expect(StyleSheet.flatten(view.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 12,
    });
  });
});
