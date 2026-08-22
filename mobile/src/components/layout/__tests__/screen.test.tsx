import { render } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { StyleSheet, Text } from "react-native";

import { Screen } from "@/components/layout/screen";
import { ThemeProvider } from "@/theme";

interface MockKeyboardEvent {
  duration: number;
  height: number;
  progress: number;
  target: number;
}

interface MockKeyboardHandler {
  onEnd?: (event: MockKeyboardEvent) => void;
  onStart?: (event: MockKeyboardEvent) => void;
}

let mockKeyboardHandler: MockKeyboardHandler | undefined;
let mockReducedMotion = false;
const mockKeyboardHeight = { value: 0 };
const mockKeyboardProgress = { value: 0 };

jest.mock("react-native-reanimated", () => {
  const { View: MockView } = require("react-native") as typeof import("react-native");
  const { useRef } = require("react") as typeof import("react");
  const reanimated = jest.requireActual("react-native-reanimated");
  return {
    ...reanimated,
    __esModule: true,
    default: { View: MockView },
    interpolate: (value: number, input: number[], output: number[]) => {
      const progress = Math.max(input[0] ?? 0, Math.min(input[1] ?? 1, value));
      return (output[0] ?? 0) + progress * ((output[1] ?? 0) - (output[0] ?? 0));
    },
    useAnimatedStyle: (updater: () => object) => updater(),
    useSharedValue: (value: number) => useRef({ value }).current,
  };
});

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
      useGenericKeyboardHandler: (handler: MockKeyboardHandler) => {
        mockKeyboardHandler = handler;
      },
      useReanimatedKeyboardAnimation: () => ({
        height: mockKeyboardHeight,
        progress: mockKeyboardProgress,
      }),
    };
  })(),
}));

jest.mock("@/lib/motion/reduced-motion", () => ({
  useReducedMotion: () => mockReducedMotion,
}));

function renderScreen(node: ReactNode) {
  return render(<ThemeProvider>{node}</ThemeProvider>);
}

describe("Screen", () => {
  beforeEach(() => {
    mockKeyboardHandler = undefined;
    mockKeyboardHeight.value = 0;
    mockKeyboardProgress.value = 0;
    mockReducedMotion = false;
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

  it("renders a full-bleed header and does not repeat its top inset", async () => {
    const screen = await renderScreen(
      <Screen header={<Text testID="scene-header">Header</Text>}>
        <Text>Content</Text>
      </Screen>,
    );

    expect(screen.getByTestId("scene-header")).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId("screen-content").props["style"])).toMatchObject({
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 0,
    });
  });

  it("threads the header through a scrolling keyboard screen", async () => {
    const screen = await renderScreen(
      <Screen header={<Text testID="scene-header">Header</Text>} scroll>
        <Text>Content</Text>
      </Screen>,
    );

    expect(screen.getByTestId("scene-header")).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByTestId("screen-content").props["style"])).toMatchObject({
      paddingTop: 0,
    });
  });

  it("drives the footer inset and position from continuous keyboard frames", async () => {
    const view = await renderScreen(
      <Screen footer={<Text>Continue</Text>} scroll>
        <Text>Form</Text>
      </Screen>,
    );

    expect(StyleSheet.flatten(view.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 34,
      transform: [{ translateY: 0 }],
    });

    mockKeyboardHandler?.onStart?.({ duration: 250, height: 300, progress: 1, target: 1 });
    mockKeyboardHeight.value = -150;
    mockKeyboardProgress.value = 0.5;
    await view.rerender(
      <ThemeProvider>
        <Screen footer={<Text>Continue</Text>} scroll>
          <Text>Form</Text>
        </Screen>
      </ThemeProvider>,
    );

    expect(StyleSheet.flatten(view.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 23,
      transform: [{ translateY: -150 }],
    });

    mockKeyboardHeight.value = -300;
    mockKeyboardProgress.value = 1;
    await view.rerender(
      <ThemeProvider>
        <Screen footer={<Text>Continue</Text>} scroll>
          <Text>Form</Text>
        </Screen>
      </ThemeProvider>,
    );

    expect(StyleSheet.flatten(view.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 12,
      transform: [{ translateY: -300 }],
    });
  });

  it("settles the inset immediately at the keyboard destination for reduced motion", async () => {
    mockReducedMotion = true;
    const view = await renderScreen(
      <Screen footer={<Text>Create</Text>} scroll>
        <Text>Form</Text>
      </Screen>,
    );

    expect(StyleSheet.flatten(view.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 34,
    });

    mockKeyboardHandler?.onStart?.({ duration: 250, height: 300, progress: 1, target: 1 });
    await view.rerender(
      <ThemeProvider>
        <Screen footer={<Text>Create</Text>} scroll>
          <Text>Form</Text>
        </Screen>
      </ThemeProvider>,
    );

    expect(mockKeyboardProgress.value).toBe(0);
    expect(StyleSheet.flatten(view.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 12,
    });
  });
});
