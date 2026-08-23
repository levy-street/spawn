import { StyleSheet, View } from "react-native";
import { AuthAction } from "@/components/auth/auth-actions";
import { authGutter } from "@/components/auth/auth-shell";
import { Text } from "@/components/ui/text";
import type { AuthProviderOut } from "@/data/api/schemas/auth";
import { borderWidth, spacing, useTheme } from "@/theme";

export interface OAuthButtonsProps {
  loading?: boolean;
  providers: readonly AuthProviderOut[];
}

/**
 * The alternate ways in, set below the email path rather than above it: email is
 * the route that works in every build, and burying it under a stack of
 * third-party plates is what made this screen read as a web form.
 */
export function OAuthButtons({ loading = false, providers }: OAuthButtonsProps) {
  const theme = useTheme();
  if (loading || providers.length === 0) return null;

  return (
    <View style={styles.container}>
      <View accessibilityElementsHidden style={styles.dividerRow}>
        <View style={[styles.line, { backgroundColor: theme.colors.border }]} />
        <Text color="mutedForeground" variant="sigilLabel">
          Or
        </Text>
        <View style={[styles.line, { backgroundColor: theme.colors.border }]} />
      </View>
      <View style={styles.buttons}>
        {providers.map((provider) => (
          <AuthAction
            accessibilityHint="Available in installed builds"
            accessibilityLabel={`Continue with ${provider.name}`}
            disabled
            key={provider.id}
            label={`Continue with ${provider.name}`}
            tone="quiet"
          />
        ))}
        <Text color="mutedForeground" style={styles.reason} variant="caption">
          Available in installed builds
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  buttons: {
    gap: spacing[3],
  },
  container: {
    gap: spacing[5],
    paddingHorizontal: authGutter,
  },
  dividerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[4],
  },
  line: {
    flex: 1,
    height: borderWidth.hairline,
  },
  reason: {
    textAlign: "center",
  },
});
