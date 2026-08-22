import { render } from "@testing-library/react-native";
import { StyleSheet, Text } from "react-native";
import { makeMutable } from "react-native-reanimated";

import { FooterActions } from "@/components/ui/footer-actions";
import { ThemeProvider } from "@/theme";

let mockReducedMotion = false;

jest.mock("react-native-reanimated", () => {
  const { View: MockView } = require("react-native") as typeof import("react-native");
  const reanimated = jest.requireActual("react-native-reanimated");
  return {
    ...reanimated,
    __esModule: true,
    default: { View: MockView },
    interpolate: (value: number, input: number[], output: number[]) => {
      const progress = Math.max(input[0] ?? 0, Math.min(input[1] ?? 1, value));
      return (output[0] ?? 0) + progress * ((output[1] ?? 0) - (output[0] ?? 0));
    },
    makeMutable: (value: number) => ({ value }),
    useAnimatedStyle: (updater: () => object) => updater(),
  };
});

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 59 }),
}));

jest.mock("@/lib/motion/reduced-motion", () => ({
  useReducedMotion: () => mockReducedMotion,
}));

describe("FooterActions", () => {
  beforeEach(() => {
    mockReducedMotion = false;
  });

  it("interpolates safe-area padding from the supplied keyboard progress", async () => {
    const height = makeMutable(0);
    const progress = makeMutable(0);
    const targetProgress = makeMutable(0);
    const screen = await render(
      <ThemeProvider>
        <FooterActions keyboardAnimation={{ height, progress, targetProgress }}>
          <Text>Cancel</Text>
          <Text>Create</Text>
        </FooterActions>
      </ThemeProvider>,
    );

    expect(StyleSheet.flatten(screen.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 34,
      transform: [{ translateY: 0 }],
    });

    height.value = -150;
    progress.value = 0.5;
    await screen.rerender(
      <ThemeProvider>
        <FooterActions keyboardAnimation={{ height, progress, targetProgress }}>
          <Text>Cancel</Text>
          <Text>Create</Text>
        </FooterActions>
      </ThemeProvider>,
    );

    expect(StyleSheet.flatten(screen.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 23,
      transform: [{ translateY: -150 }],
    });

    height.value = -300;
    progress.value = 1;
    await screen.rerender(
      <ThemeProvider>
        <FooterActions keyboardAnimation={{ height, progress, targetProgress }}>
          <Text>Cancel</Text>
          <Text>Create</Text>
        </FooterActions>
      </ThemeProvider>,
    );

    expect(StyleSheet.flatten(screen.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 12,
      transform: [{ translateY: -300 }],
    });
  });

  it("uses the destination inset immediately when reduced motion is enabled", async () => {
    mockReducedMotion = true;
    const screen = await render(
      <ThemeProvider>
        <FooterActions
          keyboardAnimation={{
            height: makeMutable(0),
            progress: makeMutable(0),
            targetProgress: makeMutable(1),
          }}
        >
          <Text>Create</Text>
        </FooterActions>
      </ThemeProvider>,
    );

    expect(StyleSheet.flatten(screen.getByTestId("footer-actions").props["style"])).toMatchObject({
      paddingBottom: 12,
    });
  });
});
