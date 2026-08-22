import { Children, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { borderWidth, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export function FooterActions({ children }: { children: ReactNode }): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.background,
          borderTopColor: theme.colors.border,
          paddingBottom: keyboardVisible
            ? sizing.footer.minimumBottomPadding
            : Math.max(sizing.footer.minimumBottomPadding, insets.bottom),
        },
      ]}
      testID="footer-actions"
    >
      {Children.map(children, (action) => (
        <View style={styles.action}>{action}</View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    flexBasis: 0,
    flexGrow: 1,
    minHeight: sizing.footer.actionHeight,
  },
  container: {
    alignItems: "stretch",
    borderTopWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: sizing.footer.actionGap,
    paddingHorizontal: sizing.footer.horizontalPadding,
    paddingTop: sizing.footer.topPadding,
    width: "100%",
  },
});
