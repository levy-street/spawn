import { StyleSheet, View } from "react-native";

import { attentionAccessibilityLabel } from "@/components/alerts/attention-badge";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";
import type { AttentionSummary } from "@/data/queries/alerts";
import { sizing } from "@/theme/sizing";

interface TabAttentionBadgeProps {
  summary: AttentionSummary | null;
  testID: string;
}

export function TabAttentionBadge({
  summary,
  testID,
}: TabAttentionBadgeProps): React.JSX.Element | null {
  if (!summary) return null;

  const tone = summary.highest === "dead" ? "destructive" : "warning";

  return (
    <View
      accessibilityLabel={attentionAccessibilityLabel(summary)}
      accessibilityRole="image"
      accessible
      style={styles.wrapper}
      testID={testID}
    >
      <Badge style={styles.plate} testID={`${testID}-count`} variant={tone}>
        <Text color={tone} style={styles.numeral} testID={`${testID}-numeral`} variant="micro">
          {summary.total > 99 ? "99+" : summary.total}
        </Text>
      </Badge>
    </View>
  );
}

const styles = StyleSheet.create({
  numeral: {
    fontVariant: ["tabular-nums"],
    includeFontPadding: false,
    lineHeight: sizing.type.micro.lineHeight,
    textAlign: "center",
    textAlignVertical: "center",
  },
  plate: {
    alignSelf: "center",
    height: sizing.tab.closePlate,
    justifyContent: "center",
    minWidth: sizing.tab.closePlate,
    paddingHorizontal: sizing.space.tight,
    paddingVertical: 0,
  },
  wrapper: {
    alignItems: "center",
    alignSelf: "center",
    justifyContent: "center",
  },
});
