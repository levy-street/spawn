import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";

import { borderWidth, useTheme } from "@/theme";

export type DividerVariant = "border" | "pane-divider";
export type DividerOrientation = "horizontal" | "vertical";

export interface DividerProps {
  orientation?: DividerOrientation;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: DividerVariant;
}

export function Divider({
  orientation = "horizontal",
  style,
  testID,
  variant = "border",
}: DividerProps) {
  const theme = useTheme();

  return (
    <View
      role="separator"
      style={[
        orientation === "horizontal" ? styles.horizontal : styles.vertical,
        {
          backgroundColor:
            variant === "pane-divider" ? theme.colors.paneDivider : theme.colors.border,
        },
        style,
      ]}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  horizontal: {
    height: borderWidth.hairline,
    width: "100%",
  },
  vertical: {
    height: "100%",
    width: borderWidth.hairline,
  },
});
