import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { alpha, borderWidth, chrome, layer, shadow, useTheme } from "@/theme";

export type SheetSnapPoint = number | string;

export interface SheetProps {
  visible: boolean;
  onDismiss: () => void;
  snapPoints?: readonly SheetSnapPoint[];
  initialSnapIndex?: number;
  enableDynamicSizing?: boolean;
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export interface SheetHeaderProps {
  title: string;
  action?: ReactNode;
}

export const SheetScrollView = BottomSheetScrollView;

/**
 * Route-backed sheet defaults for Expo Router Stack.Screen options. The system owns the
 * grabber and corner radius; callers can replace the detents for their content shape.
 */
export const NATIVE_FORM_SHEET_OPTIONS = {
  presentation: "formSheet" as const,
  sheetAllowedDetents: [0.48, 0.9],
  sheetGrabberVisible: true,
  sheetInitialDetentIndex: 0,
};

export function SheetHeader({ title, action }: SheetHeaderProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.header,
        {
          gap: theme.space(2),
          paddingBottom: theme.space(1),
          paddingHorizontal: theme.space(4),
        },
      ]}
    >
      <Text numberOfLines={1} style={styles.headerTitle} variant="label">
        {title}
      </Text>
      {action}
    </View>
  );
}

export function Sheet({
  visible,
  onDismiss,
  snapPoints,
  initialSnapIndex = 0,
  enableDynamicSizing = false,
  children,
  contentStyle,
  testID,
}: SheetProps): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const modalRef = useRef<BottomSheetModal>(null);
  const previousIndex = useRef<number | null>(null);
  const [mounted, setMounted] = useState(visible);
  const resolvedSnapPoints = useMemo<SheetSnapPoint[] | undefined>(
    () => (snapPoints ? [...snapPoints] : enableDynamicSizing ? undefined : ["48%", "90%"]),
    [enableDynamicSizing, snapPoints],
  );

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (!mounted) return;
    const frame = requestAnimationFrame(() => {
      if (visible) modalRef.current?.present();
      else modalRef.current?.dismiss();
    });
    return () => cancelAnimationFrame(frame);
  }, [mounted, visible]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        accessibilityLabel="Dismiss drawer"
        accessibilityRole="button"
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={alpha.a50}
        pressBehavior="close"
      />
    ),
    [],
  );

  const handleChange = (index: number) => {
    if (index >= 0 && previousIndex.current !== null && previousIndex.current !== index) {
      haptics.selection();
    }
    previousIndex.current = index;
  };

  const handleDismiss = useCallback(() => {
    setMounted(false);
    onDismiss();
  }, [onDismiss]);

  if (!mounted) return null;

  return (
    <BottomSheetModal
      animationConfigs={theme.motion.transition.sheet}
      android_keyboardInputMode="adjustResize"
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: theme.colors.popover,
        borderColor: theme.colors.border,
        borderBottomLeftRadius: borderWidth.none,
        borderBottomRightRadius: borderWidth.none,
        borderTopLeftRadius: theme.radii.xxl,
        borderTopRightRadius: theme.radii.xxl,
        borderTopWidth: borderWidth.hairline,
        boxShadow: shadow.xxl,
      }}
      bottomInset={borderWidth.none}
      containerStyle={{ zIndex: layer.modal }}
      enableBlurKeyboardOnGesture
      enableDismissOnClose
      enableDynamicSizing={enableDynamicSizing}
      enablePanDownToClose
      handleIndicatorStyle={{
        backgroundColor: theme.colors.border,
        borderRadius: theme.radii.pill,
        height: theme.space(1),
        width: theme.space(9),
      }}
      handleStyle={{ paddingBottom: theme.space(2), paddingTop: theme.space(2.5) }}
      index={initialSnapIndex}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      maxDynamicContentSize={Math.max(0, height - insets.top - chrome.sheetTopClearance)}
      onChange={handleChange}
      onDismiss={handleDismiss}
      ref={modalRef}
      stackBehavior="push"
      topInset={insets.top + chrome.sheetTopClearance}
      {...(resolvedSnapPoints === undefined ? {} : { snapPoints: resolvedSnapPoints })}
    >
      <BottomSheetView
        style={[contentStyle, { paddingBottom: Math.max(insets.bottom, theme.space(3)) }]}
        testID={testID ?? "sheet-content"}
      >
        {children}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: "center",
    flexDirection: "row",
  },
  headerTitle: {
    flex: 1,
  },
});
