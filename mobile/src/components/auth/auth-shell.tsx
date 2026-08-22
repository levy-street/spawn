import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "@/components/ui/text";
import {
  borderWidth,
  clampDisplay,
  displayLineHeightRatio,
  fontFamily,
  fontSize,
  fontWeight,
  layer,
  opacity,
  shadow,
  spacing,
  useTheme,
} from "@/theme";

export interface AuthShellProps {
  children: ReactNode;
  description?: ReactNode;
  title: string;
}

function RegistrationMarks() {
  const theme = useTheme();
  const marks = [
    { key: "top-left", position: styles.markTopLeft },
    { key: "top-right", position: styles.markTopRight },
    { key: "bottom-left", position: styles.markBottomLeft },
    { key: "bottom-right", position: styles.markBottomRight },
  ];
  return (
    <View accessibilityElementsHidden pointerEvents="none" style={StyleSheet.absoluteFill}>
      {marks.map(({ key, position }) => (
        <Text
          key={key}
          style={[styles.registrationMark, position, { color: theme.colors.brandAccent }]}
        >
          +
        </Text>
      ))}
    </View>
  );
}

function BrandLockup() {
  const theme = useTheme();
  return (
    <View accessibilityLabel="spawn" accessible style={styles.brandLockup}>
      <View
        accessibilityElementsHidden
        style={[styles.brandMark, { backgroundColor: theme.colors.brandAccent }]}
      >
        <View style={[styles.brandMarkCut, { backgroundColor: theme.colors.background }]} />
      </View>
      <Text
        accessibilityElementsHidden
        style={[styles.wordmark, { color: theme.colors.brandAccent }]}
      >
        SPAWN
      </Text>
    </View>
  );
}

export function AuthShell({ children, description, title }: AuthShellProps) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const titleSize = clampDisplay(width, spacing[6] + spacing[0.5], 5.9, spacing[8]);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.colors.background }]}>
      <RegistrationMarks />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboardAvoider}
      >
        <ScrollView
          automaticallyAdjustKeyboardInsets
          bounces={false}
          contentContainerStyle={styles.scrollContent}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.sheet}>
            <BrandLockup />
            <View
              style={[
                styles.plate,
                {
                  backgroundColor: theme.colors.card,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radii.sm,
                },
              ]}
            >
              <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
                <Text
                  accessibilityRole="header"
                  style={[
                    styles.title,
                    {
                      color: theme.colors.cardForeground,
                      fontSize: titleSize,
                      lineHeight: titleSize * displayLineHeightRatio.r106,
                    },
                  ]}
                >
                  {title}
                </Text>
                {description !== undefined ? (
                  typeof description === "string" || typeof description === "number" ? (
                    <Text color="mutedForeground" style={styles.description}>
                      {description}
                    </Text>
                  ) : (
                    description
                  )
                ) : null}
              </View>
              <View style={styles.content}>{children}</View>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  brandLockup: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    minHeight: spacing[11],
  },
  brandMark: {
    height: spacing[6.5],
    overflow: "hidden",
    position: "relative",
    width: spacing[6.5],
  },
  brandMarkCut: {
    bottom: -spacing[2],
    height: spacing[4],
    position: "absolute",
    right: -spacing[2],
    transform: [{ rotate: "45deg" }],
    width: spacing[4],
  },
  content: {
    padding: spacing[5],
  },
  description: {
    fontFamily: fontFamily.grimoireRegular,
    fontSize: fontSize.fifteen,
    lineHeight: spacing[6],
    marginTop: spacing[3],
  },
  header: {
    borderBottomWidth: borderWidth.hairline,
    padding: spacing[5],
  },
  keyboardAvoider: {
    flex: 1,
  },
  markBottomLeft: {
    bottom: spacing[3],
    left: spacing[4],
  },
  markBottomRight: {
    bottom: spacing[3],
    right: spacing[4],
  },
  markTopLeft: {
    left: spacing[4],
    top: spacing[3],
  },
  markTopRight: {
    right: spacing[4],
    top: spacing[3],
  },
  plate: {
    borderWidth: borderWidth.hairline,
    boxShadow: shadow.xxl,
    overflow: "hidden",
    width: "100%",
  },
  registrationMark: {
    fontFamily: fontFamily.sigil,
    fontSize: fontSize.fifteen,
    opacity: opacity.disabled,
    position: "absolute",
    zIndex: layer.tile,
  },
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingBottom: spacing[12],
    paddingHorizontal: spacing[5],
    paddingTop: spacing[12],
  },
  sheet: {
    alignSelf: "center",
    gap: spacing[6],
    maxWidth: spacing[24] * 4 + spacing[16],
    width: "100%",
  },
  title: {
    fontFamily: fontFamily.posterLight,
    fontWeight: fontWeight.light,
    textTransform: "uppercase",
  },
  wordmark: {
    fontFamily: fontFamily.sigil,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    letterSpacing: spacing[0.5],
  },
});
