import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Text as NativeText, StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Sheet } from "@/components/ui/sheet";
import { borderWidth, lightColors, radii, ThemeProvider } from "@/theme";

interface CapturedModalProps {
  backdropComponent?: (props: {
    animatedIndex: { value: number };
    animatedPosition: { value: number };
  }) => ReactNode;
  backgroundStyle?: StyleProp<ViewStyle>;
  bottomInset?: number;
  children?: ReactNode | ((props: { data?: unknown }) => ReactNode);
  enablePanDownToClose?: boolean;
  onDismiss?: () => void;
}

interface CapturedBackdropProps {
  accessibilityLabel?: string;
  onPress?: () => void;
  pressBehavior?: "none" | "close" | "collapse" | number;
}

let mockModalProps: CapturedModalProps | null = null;
let mockBackdropProps: CapturedBackdropProps | null = null;
const mockPresent = jest.fn();
const mockDismiss = jest.fn();

jest.mock("@gorhom/bottom-sheet", () => {
  const ReactModule = jest.requireActual("react") as typeof import("react");
  const Native = jest.requireActual("react-native") as typeof import("react-native");

  const BottomSheetModal = ReactModule.forwardRef<
    { dismiss: () => void; present: () => void },
    CapturedModalProps
  >((props, ref) => {
    mockModalProps = props;
    ReactModule.useImperativeHandle(ref, () => ({
      dismiss: mockDismiss,
      present: mockPresent,
    }));
    const backdrop = props.backdropComponent?.({
      animatedIndex: { value: 0 },
      animatedPosition: { value: 0 },
    });
    const content = typeof props.children === "function" ? props.children({}) : props.children;
    return (
      <Native.View>
        {backdrop}
        {content}
      </Native.View>
    );
  });

  return {
    BottomSheetBackdrop: (props: CapturedBackdropProps) => {
      mockBackdropProps = props;
      return (
        <Native.Pressable
          accessibilityLabel={props.accessibilityLabel}
          onPress={() => {
            props.onPress?.();
            if (props.pressBehavior === "close") mockModalProps?.onDismiss?.();
          }}
        />
      );
    },
    BottomSheetModal,
    BottomSheetModalProvider: ({ children }: PropsWithChildren) => children,
    BottomSheetScrollView: Native.ScrollView,
    BottomSheetView: Native.View,
  };
});

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

function Providers({ children }: PropsWithChildren): React.JSX.Element {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>{children}</ThemeProvider>
    </SafeAreaProvider>
  );
}

describe("Sheet drawer behavior", () => {
  beforeEach(() => {
    mockModalProps = null;
    mockBackdropProps = null;
    mockPresent.mockClear();
    mockDismiss.mockClear();
  });

  test("a downward close gesture dismisses the drawer", async () => {
    const onDismiss = jest.fn();
    await render(
      <Sheet onDismiss={onDismiss} visible>
        <NativeText>Drawer</NativeText>
      </Sheet>,
      { wrapper: Providers },
    );

    await waitFor(() => expect(mockPresent).toHaveBeenCalledTimes(1));
    expect(mockModalProps?.enablePanDownToClose).toBe(true);

    await act(() => mockModalProps?.onDismiss?.());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("tapping the backdrop above the drawer closes it", async () => {
    const onDismiss = jest.fn();
    const screen = await render(
      <Sheet onDismiss={onDismiss} visible>
        <NativeText>Drawer</NativeText>
      </Sheet>,
      {
        wrapper: Providers,
      },
    );

    expect(mockBackdropProps?.pressBehavior).toBe("close");
    await fireEvent.press(screen.getByLabelText("Dismiss drawer"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("the surface reaches the bottom edge and pads content above the safe area", async () => {
    const screen = await render(
      <Sheet onDismiss={jest.fn()} visible>
        <NativeText>Drawer</NativeText>
      </Sheet>,
      {
        wrapper: Providers,
      },
    );

    expect(mockModalProps?.bottomInset).toBe(borderWidth.none);
    expect(StyleSheet.flatten(mockModalProps?.backgroundStyle)).toMatchObject({
      backgroundColor: lightColors.popover,
      borderBottomLeftRadius: borderWidth.none,
      borderBottomRightRadius: borderWidth.none,
      borderTopLeftRadius: radii.xxl,
      borderTopRightRadius: radii.xxl,
    });
    expect(StyleSheet.flatten(screen.getByTestId("sheet-content").props["style"])).toMatchObject({
      paddingBottom: METRICS.insets.bottom,
    });
  });
});
