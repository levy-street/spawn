import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { Text } from "@/components/ui/text";
import { borderWidth, fontSize, useTheme } from "@/theme";

const MONOGRAM_PALETTES = [
  { background: "brandAccentSoft", foreground: "brandAccent" },
  { background: "successSoft", foreground: "success" },
  { background: "infoSoft", foreground: "info" },
  { background: "warningSoft", foreground: "warning" },
  { background: "destructiveSoft", foreground: "destructive" },
] as const;

export interface MonogramProps {
  accessibilityLabel?: string;
  seed: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: "palette" | "neutral";
}

export function monogramLetter(seed: string): string {
  return seed.match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() ?? "?";
}

export function monogramPaletteIndex(seed: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % MONOGRAM_PALETTES.length;
}

export function Monogram({
  accessibilityLabel,
  seed,
  size,
  style,
  testID,
  variant = "palette",
}: MonogramProps) {
  const theme = useTheme();
  const resolvedSize = size ?? theme.space(7);
  const palette = MONOGRAM_PALETTES[monogramPaletteIndex(seed)] ?? MONOGRAM_PALETTES[0];
  const resolvedFontSize = Math.max(fontSize.ten, Math.round(resolvedSize * 0.45));
  const neutral = variant === "neutral";

  return (
    <View
      accessibilityLabel={accessibilityLabel ?? seed}
      accessibilityRole="image"
      style={[
        styles.base,
        {
          backgroundColor: neutral ? theme.colors.muted : theme.colors[palette.background],
          borderColor: neutral ? theme.colors.border : "transparent",
          borderRadius: neutral ? theme.radii.md : theme.radii.pill,
          borderWidth: neutral ? borderWidth.hairline : borderWidth.none,
          height: resolvedSize,
          width: resolvedSize,
        },
        style,
      ]}
      testID={testID}
    >
      <Text
        color={neutral ? "mutedForeground" : palette.foreground}
        numberOfLines={1}
        style={{ fontSize: resolvedFontSize, lineHeight: resolvedSize }}
        variant="label"
      >
        {monogramLetter(seed)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
