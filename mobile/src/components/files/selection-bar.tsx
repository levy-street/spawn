import { StyleSheet, View } from "react-native";
import { SEND_SELECTION, SEND_TO_ANOTHER_HOST } from "@/components/files/transfer-copy";
import { Button } from "@/components/ui/button";
import { borderWidth, useTheme } from "@/theme";

export interface SelectionBarProps {
  count: number;
  canDelete: boolean;
  /** Sending to another host needs this host's files readable and another host to send to. */
  canSend?: boolean;
  pending?: boolean;
  onDelete: () => void;
  onSend?: () => void;
}

/** What selection mode can do with what is picked, along the bottom edge. */
export function SelectionBar({
  count,
  canDelete,
  canSend = false,
  pending = false,
  onDelete,
  onSend,
}: SelectionBarProps) {
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
      {onSend ? (
        // Short on the bar; its name is the menu's, "Send to another host…".
        <Button
          accessibilityLabel={SEND_TO_ANOTHER_HOST}
          disabled={count === 0 || !canSend || pending}
          onPress={onSend}
          size="sm"
          variant="outline"
        >
          {SEND_SELECTION}
        </Button>
      ) : null}
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
