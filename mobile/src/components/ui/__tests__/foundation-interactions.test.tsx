import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Monogram, monogramLetter, monogramPaletteIndex } from "@/components/ui/monogram";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { haptics } from "@/lib/haptics";
import { chrome, opacity, spacing, ThemeProvider } from "@/theme";

jest.mock("@/lib/haptics", () => ({
  haptics: {
    error: jest.fn(),
    impact: jest.fn(),
    overlayDismiss: jest.fn(),
    overlayOpen: jest.fn(),
    selection: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
  },
}));

function mockReduceMotion(enabled: boolean) {
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(enabled);
  const subscription = {
    remove: jest.fn(),
  } as unknown as ReturnType<typeof AccessibilityInfo.addEventListener>;
  jest.spyOn(AccessibilityInfo, "addEventListener").mockReturnValue(subscription);
}

describe("Button and EmptyState behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReduceMotion(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does not fire a disabled button", async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <Button disabled onPress={onPress}>
          Disabled
        </Button>
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Disabled" }));

    expect(onPress).not.toHaveBeenCalled();
    expect(haptics.impact).not.toHaveBeenCalled();
  });

  it("keeps loading label content mounted while showing the spinner", async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <Button loading onPress={onPress} testID="loading-button">
          Launch workspace
        </Button>
      </ThemeProvider>,
    );

    expect(screen.getByText("Launch workspace")).toBeOnTheScreen();
    expect(
      screen.getByTestId("loading-button-spinner", { includeHiddenElements: true }),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Launch workspace" }));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("fires light impact for ordinary actions and warning for destructive actions", async () => {
    const onDefault = jest.fn();
    const onDestructive = jest.fn();
    await render(
      <ThemeProvider>
        <View>
          <Button onPress={onDefault}>Save</Button>
          <Button onPress={onDestructive} variant="destructive">
            Delete
          </Button>
        </View>
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Save" }));
    expect(haptics.impact).toHaveBeenCalledWith("light");
    expect(onDefault).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole("button", { name: "Delete" }));
    expect(haptics.warning).toHaveBeenCalledTimes(1);
    expect(onDestructive).toHaveBeenCalledTimes(1);
  });

  it("exposes a required accessible name for icon-only buttons", async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <IconButton accessibilityLabel="Open settings" icon="Settings" onPress={onPress} />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Open settings" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("expands every visual button size to at least a 44 point touch target", async () => {
    await render(
      <ThemeProvider>
        <View>
          <Button size="sm" testID="small-button">
            Small
          </Button>
          <Button testID="default-button">Default</Button>
          <Button size="lg" testID="large-button">
            Large
          </Button>
        </View>
      </ThemeProvider>,
    );

    const expectations = [
      ["small-button", spacing[9]],
      ["default-button", spacing[10]],
      ["large-button", spacing[11]],
    ] as const;
    for (const [testID, visualHeight] of expectations) {
      const button = screen.getByTestId(testID);
      const buttonProps = button.props as { hitSlop: number };
      expect(buttonProps.hitSlop).toBe((chrome.touchTarget - visualHeight) / 2);
    }
  });

  it("renders and fires a caller-supplied EmptyState action", async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <EmptyState
          action={<Button onPress={onPress}>Create workspace</Button>}
          description="Start by choosing a machine and folder."
          icon="FolderPlus"
          title="No workspaces"
        />
      </ThemeProvider>,
    );

    expect(screen.getByText("No workspaces")).toBeOnTheScreen();
    expect(screen.getByText("Start by choosing a machine and folder.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("button", { name: "Create workspace" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("reduced motion", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders an active StatusDot without its ping", async () => {
    mockReduceMotion(true);
    await render(
      <ThemeProvider>
        <StatusDot testID="reduced-status" tone="active" />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("reduced-status-pulse", { includeHiddenElements: true }),
      ).not.toBeOnTheScreen();
    });
    expect(screen.getByTestId("reduced-status", { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it("leaves Skeleton at its static muted opacity", async () => {
    mockReduceMotion(true);
    await render(
      <ThemeProvider>
        <Skeleton style={{ height: 20, width: 100 }} testID="reduced-skeleton" />
      </ThemeProvider>,
    );

    await waitFor(() => {
      const skeleton = screen.getByTestId("reduced-skeleton", { includeHiddenElements: true });
      const skeletonProps = skeleton.props as { style: StyleProp<ViewStyle> };
      const style = StyleSheet.flatten(skeletonProps.style);
      expect(style.opacity).toBe(opacity.skeleton);
    });
  });
});

describe("Monogram helpers", () => {
  it("derives the first alphanumeric letter", () => {
    expect(monogramLetter("  aider")).toBe("A");
    expect(monogramLetter("--9 lives")).toBe("9");
    expect(monogramLetter("---")).toBe("?");
  });

  it("selects a deterministic palette", async () => {
    expect(monogramPaletteIndex("custom-agent")).toBe(monogramPaletteIndex("custom-agent"));
    expect(monogramPaletteIndex("custom-agent")).toBeGreaterThanOrEqual(0);

    mockReduceMotion(false);
    await render(
      <ThemeProvider>
        <Monogram seed="custom-agent" testID="monogram" />
      </ThemeProvider>,
    );
    expect(screen.getByText("C")).toBeOnTheScreen();
  });
});
