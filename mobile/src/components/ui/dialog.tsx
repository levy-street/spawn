import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import { Modal, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { KeyboardContext } from "react-native-keyboard-controller/src/context";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { useBottomChromeOwnsInset } from "@/components/layout/bottom-chrome";
import { registerNavigationOverlayDismiss } from "@/components/nav/overlay-dismiss";
import { FooterActions } from "@/components/ui/footer-actions";
import { IconButton } from "@/components/ui/icon-button";
import { useReducedMotionPreference } from "@/components/ui/swipe-dismiss-overlay";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { layer, opacity, spacing, useTheme } from "@/theme";
import { bottomNavHeight, sizing } from "@/theme/sizing";

export type DialogSize = "sm" | "md" | "lg" | "full-mobile" | "viewer";

/** Long enough to read as an arrival, short enough not to delay the first tap. */
const DIALOG_RISE_MS = 300;

export interface DialogProps {
  visible: boolean;
  onDismiss: () => void;
  title?: string;
  description?: ReactNode;
  size?: DialogSize;
  /** The header's X. The way out of a dialog; its actions are the caller's own. */
  showCloseButton?: boolean;
  closeAccessibilityLabel?: string;
  /** The pinned action row. A dialog states its own answers — there is no default. */
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
  testID?: string;
}

function flattenFooterActions(node: ReactNode): ReactNode[] {
  return Children.toArray(node).flatMap((child) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      return flattenFooterActions(child.props.children);
    }
    return [child];
  });
}

function DialogFooter({
  children,
  reservedBottomChrome,
}: {
  children: ReactNode;
  reservedBottomChrome: number;
}): React.JSX.Element {
  // Read the provider's context directly so importing Dialog does not eagerly load native
  // bindings in provider-light routes and tests.
  const keyboard = useContext(KeyboardContext);
  const { height, progress } = keyboard.reanimated;
  const targetProgress = useSharedValue(progress.value);

  useLayoutEffect(
    () =>
      keyboard.setKeyboardHandlers({
        onStart: (event) => {
          "worklet";
          targetProgress.value = event.progress;
        },
        onEnd: (event) => {
          "worklet";
          targetProgress.value = event.progress;
        },
      }),
    [keyboard, targetProgress],
  );

  return (
    <FooterActions
      keyboardAnimation={{ height, progress, targetProgress }}
      reservedBottomChrome={reservedBottomChrome}
    >
      {children}
    </FooterActions>
  );
}

export function Dialog({
  visible,
  onDismiss,
  title,
  description,
  showCloseButton = true,
  closeAccessibilityLabel = "Close dialog",
  footer,
  contentStyle,
  children,
  testID,
}: DialogProps): React.JSX.Element | null {
  const theme = useTheme();
  const reducedMotion = useReducedMotionPreference();
  // Rises a short distance rather than travelling the screen's full height: the
  // page is already there, this is something arriving on top of it.
  const rise = useSharedValue(reducedMotion ? 0 : sizing.dialog.riseDistance);
  const riseStyle = useAnimatedStyle(() => ({
    opacity: interpolate(rise.value, [sizing.dialog.riseDistance, 0], [0, opacity.opaque]),
    transform: [{ translateY: rise.value }],
  }));
  const insets = useSafeAreaInsets();
  const childInsets = useMemo(() => ({ ...insets, top: spacing[0] }), [insets]);
  // The nav bar is portalled to window level, which puts it *over* this modal
  // rather than behind it. Nothing else holds its footprint open here, so a
  // dialog's own foot has to, or the bar sits on top of the actions.
  const reservedBottomChrome = useBottomChromeOwnsInset() ? bottomNavHeight(insets.bottom) : 0;

  useEffect(() => {
    if (visible) haptics.overlayOpen();
  }, [visible]);

  // A dialog is state-driven rather than a route, so a nav tap had nothing to pop
  // and left the form standing over the destination. Registering here puts it in
  // the same set of overlays the bar clears before it lands on a root.
  useEffect(() => {
    if (!visible) return;
    return registerNavigationOverlayDismiss(onDismiss);
  }, [onDismiss, visible]);

  useEffect(() => {
    if (!visible) {
      rise.value = reducedMotion ? 0 : sizing.dialog.riseDistance;
      return;
    }
    rise.value = reducedMotion
      ? 0
      : withTiming(0, { duration: DIALOG_RISE_MS, easing: Easing.out(Easing.cubic) });
  }, [reducedMotion, rise, visible]);

  if (!visible) return null;

  const hasHeader = title !== undefined || description !== undefined;
  const footerActions = footer === undefined ? [] : flattenFooterActions(footer);
  const ChildInsetsProvider = SafeAreaInsetsContext?.Provider;

  return (
    <Modal
      animationType="none"
      onRequestClose={onDismiss}
      presentationStyle="fullScreen"
      statusBarTranslucent
      visible
    >
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.surface,
          {
            paddingBottom:
              footer === undefined ? Math.max(insets.bottom, reservedBottomChrome) : spacing[0],
          },
          contentStyle,
          { backgroundColor: theme.colors.background, zIndex: layer.modal },
          riseStyle,
        ]}
        testID={testID ?? "dialog-content"}
      >
        {hasHeader ? (
          <View
            style={[
              styles.header,
              {
                gap: theme.space(1),
                paddingBottom: theme.space(4),
                paddingHorizontal: theme.space(4),
                // The title row stands as tall as its close control now, which
                // carries part of the clearance the padding used to owe on its own.
                paddingTop: insets.top + theme.space(3),
              },
            ]}
            testID="dialog-header"
          >
            {/* The close control shares a row with the title alone, so it centres
                on that line rather than on a copy block a description may extend. */}
            <View style={[styles.titleRow, { gap: theme.space(3) }]}>
              <View style={styles.titleCopy}>
                {title !== undefined ? (
                  <Text accessibilityRole="header" variant="uiLg" weight="semibold">
                    {title}
                  </Text>
                ) : null}
              </View>
              {showCloseButton ? (
                <IconButton
                  accessibilityLabel={closeAccessibilityLabel}
                  icon="X"
                  onPress={onDismiss}
                  size="lg"
                />
              ) : null}
            </View>
            {description !== undefined ? (
              typeof description === "string" ? (
                <Text color="mutedForeground" variant="body">
                  {description}
                </Text>
              ) : (
                description
              )
            ) : null}
          </View>
        ) : null}

        {ChildInsetsProvider === undefined ? (
          <View style={styles.body} testID="dialog-body">
            {children}
          </View>
        ) : (
          <ChildInsetsProvider value={childInsets}>
            <View style={styles.body} testID="dialog-body">
              {children}
            </View>
          </ChildInsetsProvider>
        )}

        {footerActions.length > 0 ? (
          <DialogFooter reservedBottomChrome={reservedBottomChrome}>{footerActions}</DialogFooter>
        ) : null}

        {!hasHeader && showCloseButton ? (
          <View
            pointerEvents="box-none"
            style={[styles.close, { right: theme.space(3), top: insets.top + theme.space(2) }]}
          >
            <IconButton
              accessibilityLabel={closeAccessibilityLabel}
              icon="X"
              onPress={onDismiss}
              size="sm"
            />
          </View>
        ) : null}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  close: {
    position: "absolute",
  },
  header: {
    alignItems: "stretch",
  },
  titleCopy: {
    flex: 1,
    justifyContent: "center",
    minWidth: 0,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  surface: {
    flex: 1,
    width: "100%",
  },
});
