import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetModal,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
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
}: SheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const modalRef = useRef<BottomSheetModal>(null);
  const previousIndex = useRef<number | null>(null);
  const resolvedSnapPoints = useMemo<SheetSnapPoint[] | undefined>(
    () => (snapPoints ? [...snapPoints] : enableDynamicSizing ? undefined : ["48%", "90%"]),
    [enableDynamicSizing, snapPoints],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (visible) modalRef.current?.present();
      else modalRef.current?.dismiss();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
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

  return (
    <BottomSheetModal
      animationConfigs={theme.motion.transition.sheet}
      android_keyboardInputMode="adjustResize"
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: theme.colors.popover,
        borderColor: theme.colors.border,
        borderTopLeftRadius: theme.radii.xxl,
        borderTopRightRadius: theme.radii.xxl,
        borderTopWidth: borderWidth.hairline,
        boxShadow: shadow.xxl,
      }}
      bottomInset={insets.bottom}
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
      maxDynamicContentSize={Math.max(
        0,
        height - insets.top - insets.bottom - chrome.sheetTopClearance,
      )}
      onChange={handleChange}
      onDismiss={onDismiss}
      ref={modalRef}
      stackBehavior="push"
      topInset={insets.top + chrome.sheetTopClearance}
      {...(resolvedSnapPoints === undefined ? {} : { snapPoints: resolvedSnapPoints })}
    >
      <BottomSheetView style={contentStyle} testID={testID ?? "sheet-content"}>
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
