import { render, screen } from "@testing-library/react-native";
import { type PropsWithChildren, useEffect } from "react";
import { AccessibilityInfo, View } from "react-native";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Divider } from "@/components/ui/divider";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Monogram } from "@/components/ui/monogram";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { type ThemeMode, ThemeProvider, useThemeMode } from "@/theme";

function ForceTheme({ children, mode }: PropsWithChildren<{ mode: ThemeMode }>) {
  const { setMode } = useThemeMode();

  useEffect(() => {
    setMode(mode);
  }, [mode, setMode]);

  return children;
}

function TestTheme({ children, mode }: PropsWithChildren<{ mode: ThemeMode }>) {
  return (
    <ThemeProvider>
      <ForceTheme mode={mode}>{children}</ForceTheme>
    </ThemeProvider>
  );
}

const BADGE_VARIANTS = [
  "default",
  "outline",
  "success",
  "warning",
  "info",
  "destructive",
  "success-soft",
  "warning-soft",
  "info-soft",
  "destructive-soft",
] as const satisfies readonly BadgeVariant[];

const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
] as const satisfies readonly ButtonVariant[];

const BUTTON_SIZES = ["default", "sm", "lg", "icon"] as const satisfies readonly ButtonSize[];

describe("UI foundation rendering", () => {
  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
    const subscription = {
      remove: jest.fn(),
    } as unknown as ReturnType<typeof AccessibilityInfo.addEventListener>;
    jest.spyOn(AccessibilityInfo, "addEventListener").mockReturnValue(subscription);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(["light", "dark"] as const)("renders every primitive in %s mode", async (mode) => {
    await render(
      <TestTheme mode={mode}>
        <View>
          <Text testID="text">Body</Text>
          <Button testID="button">Run</Button>
          <IconButton accessibilityLabel="Open menu" icon="Menu" testID="icon-button" />
          <Card testID="card">
            <Text>Card</Text>
          </Card>
          <Badge testID="badge">ready</Badge>
          <StatusDot pulse={false} testID="status" tone="active" />
          <Spinner testID="spinner" />
          <Skeleton style={{ height: 20, width: 100 }} testID="skeleton" />
          <Divider testID="divider" />
          <Monogram seed="Codex" testID="monogram" />
          <Chip testID="chip">connected</Chip>
          <Icon name="Terminal" testID="icon" />
          <EmptyState icon="Folder" testID="empty" title="Nothing here" />
        </View>
      </TestTheme>,
    );

    for (const testID of [
      "text",
      "button",
      "icon-button",
      "card",
      "badge",
      "status",
      "spinner",
      "skeleton",
      "divider",
      "monogram",
      "chip",
      "icon",
      "empty",
    ]) {
      expect(screen.getByTestId(testID, { includeHiddenElements: true })).toBeOnTheScreen();
    }
  });

  it("renders every Badge and Chip variant", async () => {
    await render(
      <TestTheme mode="light">
        <View>
          {BADGE_VARIANTS.map((variant) => (
            <View key={variant}>
              <Badge testID={`badge-${variant}`} variant={variant}>
                {variant}
              </Badge>
              <Chip testID={`chip-${variant}`} variant={variant}>
                {variant}
              </Chip>
            </View>
          ))}
        </View>
      </TestTheme>,
    );

    for (const variant of BADGE_VARIANTS) {
      expect(screen.getByTestId(`badge-${variant}`)).toBeOnTheScreen();
      expect(screen.getByTestId(`chip-${variant}`)).toBeOnTheScreen();
    }
  });

  it("renders every Button variant and size", async () => {
    await render(
      <TestTheme mode="dark">
        <View>
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} testID={`button-${variant}`} variant={variant}>
              {variant}
            </Button>
          ))}
          {BUTTON_SIZES.map((size) => (
            <Button key={size} size={size} testID={`button-size-${size}`}>
              {size}
            </Button>
          ))}
        </View>
      </TestTheme>,
    );

    for (const variant of BUTTON_VARIANTS) {
      expect(screen.getByTestId(`button-${variant}`)).toBeOnTheScreen();
    }
    for (const size of BUTTON_SIZES) {
      expect(screen.getByTestId(`button-size-${size}`)).toBeOnTheScreen();
    }
  });

  it("renders all status tones", async () => {
    await render(
      <TestTheme mode="dark">
        <View>
          {(["active", "waiting", "idle", "offline"] as const).map((tone) => (
            <StatusDot key={tone} pulse={false} testID={`status-${tone}`} tone={tone} />
          ))}
        </View>
      </TestTheme>,
    );

    for (const tone of ["active", "waiting", "idle", "offline"]) {
      expect(
        screen.getByTestId(`status-${tone}`, { includeHiddenElements: true }),
      ).toBeOnTheScreen();
    }
  });
});
