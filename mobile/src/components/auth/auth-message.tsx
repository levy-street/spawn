import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Icon, type IconName } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { spacing, useTheme } from "@/theme";

export type AuthMessageTone = "error" | "info" | "success";

export interface AuthMessageProps {
  children: ReactNode;
  tone?: AuthMessageTone;
}

const TONE_TOKENS = {
  error: { background: "destructiveSoft", color: "destructive", icon: "AlertCircle" },
  info: { background: "infoSoft", color: "info", icon: "Mail" },
  success: { background: "successSoft", color: "success", icon: "CheckCircle2" },
} as const satisfies Record<
  AuthMessageTone,
  {
    background: "destructiveSoft" | "infoSoft" | "successSoft";
    color: "destructive" | "info" | "success";
    icon: IconName;
  }
>;

export function AuthMessage({ children, tone = "info" }: AuthMessageProps) {
  const theme = useTheme();
  const tokens = TONE_TOKENS[tone];
  return (
    <View
      accessibilityLiveRegion={tone === "error" ? "assertive" : "polite"}
      accessibilityRole={tone === "error" ? "alert" : "text"}
      style={[
        styles.container,
        {
          backgroundColor: theme.colors[tokens.background],
          borderRadius: theme.radii.sm,
        },
      ]}
    >
      <Icon color={tokens.color} name={tokens.icon} size={spacing[5]} />
      <Text color={tokens.color} style={styles.copy} weight="medium">
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
    padding: spacing[4],
  },
  copy: {
    flex: 1,
  },
});
