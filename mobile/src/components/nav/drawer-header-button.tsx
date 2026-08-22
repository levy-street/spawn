import { Pressable, StyleSheet } from "react-native";

import { Icon } from "@/components/ui/icon";
import { chrome, radii, spacing, useTheme } from "@/theme";

export interface DrawerHeaderButtonProps {
  onPress: () => void;
}

export function DrawerHeaderButton({ onPress }: DrawerHeaderButtonProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityLabel="Open navigation menu"
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        { backgroundColor: pressed ? theme.colors.accent : theme.colors.background },
      ]}
      testID="drawer-menu-button"
    >
      <Icon name="Menu" size={spacing[5]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  control: {
    alignItems: "center",
    borderRadius: radii.md,
    height: chrome.touchTarget,
    justifyContent: "center",
    width: chrome.touchTarget,
  },
});
