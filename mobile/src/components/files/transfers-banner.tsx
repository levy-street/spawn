import { Pressable, StyleSheet } from "react-native";
import { transfersBannerLabel } from "@/components/files/transfer-copy";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { summarizeTransfers, useTransfersStore } from "@/data/stores/transfers";
import { spacing, useTheme } from "@/theme";

/**
 * "2 transfers · 45%" over a folder's list while anything has been sent or
 * uploaded, on every host's files: the queue is the app's, not the folder's.
 * It counts transfers as they were asked for — one send of a folder of a
 * thousand files is one — and says first when one needs the person.
 * Tapping it opens the Transfers sheet.
 */
export function TransfersBanner(): React.JSX.Element | null {
  const theme = useTheme();
  const batches = useTransfersStore((state) => state.batches);
  const paused = useTransfersStore((state) => state.paused);
  const showSheet = useTransfersStore((state) => state.showSheet);
  const summary = summarizeTransfers({ batches, paused });
  if (!summary.any) return null;
  const label = transfersBannerLabel(summary);
  const attention = summary.paused || summary.needsYou > 0;
  return (
    <Pressable
      accessibilityHint="Opens Transfers"
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={showSheet}
      style={({ pressed }) => [
        styles.banner,
        {
          backgroundColor: pressed
            ? theme.colors.accent
            : attention
              ? theme.colors.warningSoft
              : theme.colors.muted,
        },
      ]}
      testID="transfers-banner"
    >
      {summary.running ? (
        <Spinner label={label} size={spacing[4]} />
      ) : (
        <Icon
          color={attention ? "warning" : "mutedForeground"}
          name={attention ? "AlertCircle" : "ArrowRightLeft"}
        />
      )}
      <Text
        accessibilityLiveRegion="polite"
        color={attention ? "warning" : "foreground"}
        numberOfLines={1}
        style={styles.label}
        variant="label"
      >
        {label}
      </Text>
      <Icon color="mutedForeground" name="ChevronRight" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  label: { flex: 1 },
});
