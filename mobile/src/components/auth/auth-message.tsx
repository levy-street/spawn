import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { authGutter } from "@/components/auth/auth-shell";
import { Icon, type IconName } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { fontFamily, fontSize, lineHeight, spacing } from "@/theme";

export type AuthMessageTone = "error" | "info" | "success";

export interface AuthMessageProps {
  children: ReactNode;
  tone?: AuthMessageTone;
}

const TONE_TOKENS = {
  error: { color: "destructive", icon: "AlertCircle" },
  info: { color: "info", icon: "Mail" },
  success: { color: "success", icon: "CheckCircle2" },
} as const satisfies Record<
  AuthMessageTone,
  { color: "destructive" | "info" | "success"; icon: IconName }
>;

/**
 * A notice printed on the sheet, not a chip laid on it. The tone is carried by
 * the ink the line is set in and the glyph that opens it — a tinted plate here
 * would be the very container the sheet exists to avoid.
 */
export function AuthMessage({ children, tone = "info" }: AuthMessageProps) {
  const tokens = TONE_TOKENS[tone];
  return (
    <View
      accessibilityLiveRegion={tone === "error" ? "assertive" : "polite"}
      accessibilityRole={tone === "error" ? "alert" : "text"}
      style={styles.container}
    >
      <View style={styles.glyph}>
        <Icon color={tokens.color} name={tokens.icon} size={spacing[4]} />
      </View>
      <Text color={tokens.color} style={styles.copy}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[2.5],
    paddingHorizontal: authGutter,
  },
  copy: {
    flex: 1,
    fontFamily: fontFamily.grimoireRegular,
    fontSize: fontSize.sm,
    lineHeight: lineHeight.sm,
  },
  glyph: {
    // Optically centres the glyph on the first line of copy rather than on the
    // block, which is where it drifts once the message wraps.
    paddingTop: spacing[0.5],
  },
});
