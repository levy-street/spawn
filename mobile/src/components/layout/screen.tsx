import { HeaderHeightContext } from "@react-navigation/elements";
import { type ReactNode, useContext } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { spacing } from "@/theme";

export interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  footer?: ReactNode;
  padded?: boolean;
}

export function Screen({
  children,
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
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const gutter = padded ? spacing[4] : spacing[0];
  const contentInsets = {
    paddingBottom:
      footer === undefined ? Math.max(spacing[6], insets.bottom + spacing[4]) : spacing[0],
    paddingLeft: insets.left + gutter,
    paddingRight: insets.right + gutter,
    // Native-stack headers already place their scene below the status bar.
    paddingTop: headerHeight > 0 ? spacing[0] : insets.top,
  };

  if (scroll || footer !== undefined) {
    // Form-only native bindings stay out of ordinary route imports and their lightweight tests.
    const { KeyboardScreen } =
      require("@/components/layout/keyboard-screen") as typeof import("@/components/layout/keyboard-screen");
    return (
      <KeyboardScreen contentInsets={contentInsets} footer={footer} scroll={scroll}>
        {children}
      </KeyboardScreen>
    );
  }

  return (
    <View style={styles.root} testID="screen">
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
