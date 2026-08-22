import { Image } from "expo-image";
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
import { BrandMark, Wordmark } from "@/components/brand/brand-mark";
import { Text } from "@/components/ui/text";
import {
  alpha,
  borderWidth,
  clampDisplay,
  displayLineHeightRatio,
  FixedThemeProvider,
  fontFamily,
  fontSize,
  fontWeight,
  layer,
  opacity,
  pressroomColors,
  radii,
  shadow,
  spacing,
} from "@/theme";

export interface AuthShellProps {
  children: ReactNode;
  description?: ReactNode;
  title: string;
}

function RegistrationMarks() {
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
          style={[styles.registrationMark, position, { color: pressroomColors.hellfire }]}
        >
          +
        </Text>
      ))}
    </View>
  );
}

function BrandLockup() {
  return (
    <View accessibilityLabel="spawnd" accessible style={styles.brandLockup}>
      <BrandMark color={pressroomColors.hellfire} size={spacing[6.5]} testID="auth-brand-mark" />
      <Wordmark color={pressroomColors.hellfire} height={spacing[5]} testID="auth-wordmark" />
    </View>
  );
}

export function AuthShell(props: AuthShellProps) {
  // The Pressroom ground is a fixed dark plate, so the controls on it must not
  // follow the device into light mode — that paints near-black labels on a
  // near-black card and makes the whole screen unreadable.
  return (
    <FixedThemeProvider mode="dark">
      <AuthShellSurface {...props} />
    </FixedThemeProvider>
  );
}

function AuthShellSurface({ children, description, title }: AuthShellProps) {
  const { width } = useWindowDimensions();
  const titleSize = clampDisplay(width, spacing[6] + spacing[0.5], 5.9, spacing[8]);

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: pressroomColors.void }]}
      testID="auth-pressroom"
    >
      <Image
        accessibilityElementsHidden
        contentFit="cover"
        contentPosition={{ left: "50%", top: "32%" }}
        pointerEvents="none"
        source={require("../../../assets/images/altar-ink.png")}
        style={styles.backdrop}
        testID="auth-altar"
      />
      <View
        accessibilityElementsHidden
        pointerEvents="none"
        style={[styles.scrim, { backgroundColor: pressroomColors.void }]}
      />
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
                  backgroundColor: pressroomColors.char,
                  borderColor: pressroomColors.lineG,
                  borderRadius: radii.sm,
                },
              ]}
              testID="auth-plate"
            >
              <View style={[styles.header, { borderBottomColor: pressroomColors.lineG }]}>
                <Text
                  accessibilityRole="header"
                  style={[
                    styles.title,
                    {
                      color: pressroomColors.bone,
                      fontSize: titleSize,
                      lineHeight: titleSize * displayLineHeightRatio.r106,
                    },
                  ]}
                >
                  {title}
                </Text>
                {description !== undefined ? (
                  typeof description === "string" || typeof description === "number" ? (
                    <Text style={[styles.description, { color: pressroomColors.ash }]}>
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
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  brandLockup: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    minHeight: spacing[11],
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
  scrim: {
    ...StyleSheet.absoluteFillObject,
    opacity: alpha.a80,
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
});
