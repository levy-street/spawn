import { type ReactNode, useContext } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { useBottomChromeOwnsInset } from "@/components/layout/bottom-chrome";
import { spacing } from "@/theme";
import { bottomNavHeight } from "@/theme/sizing";

export interface ScreenProps {
  children: ReactNode;
  /** Rendered above the content, outside the gutter, owning the top inset. */
  header?: ReactNode;
  scroll?: boolean;
  footer?: ReactNode;
  padded?: boolean;
}

export function Screen({
  children,
  header,
  scroll = false,
  footer,
  padded = true,
}: ScreenProps): React.JSX.Element {
  const insets = useContext(SafeAreaInsetsContext) ?? {
    bottom: spacing[0],
    left: spacing[0],
    right: spacing[0],
    top: spacing[0],
  };
  const gutter = padded ? spacing[4] : spacing[0];
  // Persistent bottom chrome reserves and paints the device inset itself, so a
  // screen above it adds only its own breathing room — or none at all when it
  // runs edge to edge and should meet the bar's border directly.
  const bottomChromeOwnsInset = useBottomChromeOwnsInset();
  // The bar is portalled to window level, so nothing holds its footprint open in
  // the layout flow but this. It already paints the device inset, so the screen
  // must not add that inset again on top.
  const restingBottomInset = bottomChromeOwnsInset
    ? bottomNavHeight(insets.bottom) + gutter
    : Math.max(spacing[6], insets.bottom + spacing[4]);
  const contentInsets = {
    paddingBottom: footer === undefined ? restingBottomInset : spacing[0],
    paddingLeft: insets.left + gutter,
    paddingRight: insets.right + gutter,
    paddingTop: header === undefined ? insets.top : spacing[0],
  };

  if (scroll || footer !== undefined) {
    // Form-only native bindings stay out of ordinary route imports and their lightweight tests.
    const { KeyboardScreen } =
      require("@/components/layout/keyboard-screen") as typeof import("@/components/layout/keyboard-screen");
    return (
      <KeyboardScreen contentInsets={contentInsets} footer={footer} header={header} scroll={scroll}>
        {children}
      </KeyboardScreen>
    );
  }

  return (
    <View style={styles.root} testID="screen">
      {header}
      <View style={[styles.content, contentInsets]} testID="screen-content">
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
  },
  root: {
    flex: 1,
  },
});
