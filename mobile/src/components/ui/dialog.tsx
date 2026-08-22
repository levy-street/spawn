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
import { useSharedValue } from "react-native-reanimated";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { FooterActions } from "@/components/ui/footer-actions";
import { IconButton } from "@/components/ui/icon-button";
import { useReducedMotionPreference } from "@/components/ui/swipe-dismiss-overlay";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { layer, spacing, useTheme } from "@/theme";

export type DialogSize = "sm" | "md" | "lg" | "full-mobile" | "viewer";

export interface DialogProps {
  visible: boolean;
  onDismiss: () => void;
  title?: string;
  description?: ReactNode;
  size?: DialogSize;
  showCloseButton?: boolean;
  closeAccessibilityLabel?: string;
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

function DialogFooter({ children }: { children: ReactNode }): React.JSX.Element {
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
    <FooterActions keyboardAnimation={{ height, progress, targetProgress }}>
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
  const insets = useSafeAreaInsets();
  const childInsets = useMemo(() => ({ ...insets, top: spacing[0] }), [insets]);

  useEffect(() => {
    if (visible) haptics.overlayOpen();
  }, [visible]);

  if (!visible) return null;

  const hasHeader = title !== undefined || description !== undefined;
  const footerActions = footer === undefined ? [] : flattenFooterActions(footer);
  const ChildInsetsProvider = SafeAreaInsetsContext?.Provider;

  return (
    <Modal
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={onDismiss}
      presentationStyle="fullScreen"
      statusBarTranslucent
      visible
    >
      <View
        accessibilityViewIsModal
        style={[
          styles.surface,
          {
            paddingBottom: footer === undefined ? insets.bottom : spacing[0],
          },
          contentStyle,
          { backgroundColor: theme.colors.background, zIndex: layer.modal },
        ]}
        testID={testID ?? "dialog-content"}
      >
        {hasHeader ? (
          <View
            style={[
              styles.header,
              {
                gap: theme.space(3),
                paddingBottom: theme.space(4),
                paddingHorizontal: theme.space(4),
                paddingTop: insets.top + theme.space(2),
              },
            ]}
            testID="dialog-header"
          >
            <View style={[styles.headerCopy, { gap: theme.space(1) }]}>
              {title !== undefined ? (
                <Text accessibilityRole="header" variant="uiLg" weight="semibold">
                  {title}
                </Text>
              ) : null}
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
            {showCloseButton ? (
              <IconButton
                accessibilityLabel={closeAccessibilityLabel}
                icon="X"
                onPress={onDismiss}
                size="sm"
              />
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

        {footerActions.length > 0 ? <DialogFooter>{footerActions}</DialogFooter> : null}

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
      </View>
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
    alignItems: "flex-start",
    flexDirection: "row",
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  surface: {
    flex: 1,
    width: "100%",
  },
});
