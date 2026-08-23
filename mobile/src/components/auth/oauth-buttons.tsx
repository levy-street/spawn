import { StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Divider } from "@/components/ui/divider";
import { Text } from "@/components/ui/text";
import type { AuthProviderOut } from "@/data/api/schemas/auth";
import { fontFamily, fontSize, letterSpacing, spacing } from "@/theme";

export interface OAuthButtonsProps {
  loading?: boolean;
  providers: readonly AuthProviderOut[];
}

export function OAuthButtons({ loading = false, providers }: OAuthButtonsProps) {
  if (loading || providers.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.buttons}>
        {providers.map((provider) => (
          <Button
            accessibilityHint="Available in installed builds"
            accessibilityLabel={`Continue with ${provider.name}`}
            disabled
            key={provider.id}
            size="lg"
            variant="outline"
          >
            Continue with {provider.name}
          </Button>
        ))}
      </View>
      <Text color="mutedForeground" style={styles.reason}>
        Available in installed builds
      </Text>
      <View accessibilityElementsHidden style={styles.dividerRow}>
        <View style={styles.line}>
          <Divider />
        </View>
        <Text color="mutedForeground" style={styles.dividerLabel}>
          OR USE EMAIL
        </Text>
        <View style={styles.line}>
          <Divider />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: {
    gap: spacing[2],
  },
  container: {
    gap: spacing[3],
  },
  dividerLabel: {
    fontFamily: fontFamily.sigil,
    fontSize: fontSize.ten,
    letterSpacing: letterSpacing.sigil22Em * fontSize.ten,
  },
  dividerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  line: {
    flex: 1,
  },
  reason: {
    textAlign: "center",
  },
});
