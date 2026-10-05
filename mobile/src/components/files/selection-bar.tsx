import { StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button";
import { borderWidth, useTheme } from "@/theme";

export interface SelectionBarProps {
  count: number;
  /** Deleting is what the host can do to a selection today; sending and moving come later. */
  canDelete: boolean;
  pending?: boolean;
  onDelete: () => void;
}

/** What selection mode can do with what is picked, along the bottom edge. */
export function SelectionBar({ count, canDelete, pending = false, onDelete }: SelectionBarProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.background,
          borderTopColor: theme.colors.border,
          gap: theme.space(2),
          paddingHorizontal: theme.space(4),
          paddingVertical: theme.space(2),
        },
      ]}
      testID="file-selection-bar"
    >
      <Button
        accessibilityLabel={count === 1 ? "Delete 1 item" : `Delete ${count} items`}
        disabled={count === 0 || !canDelete}
        loading={pending}
        onPress={onDelete}
        size="sm"
        variant="destructive"
      >
        Delete…
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    borderTopWidth: borderWidth.hairline,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
});
