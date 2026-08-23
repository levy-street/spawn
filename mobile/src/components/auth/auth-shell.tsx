import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import Animated, { FadeInDown, ReduceMotion } from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandMark, Wordmark } from "@/components/brand/brand-mark";
import { Icon, type IconName } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import {
  borderWidth,
  clampDisplay,
  displayClamp,
  displayLineHeightRatio,
  duration,
  easing,
  fontFamily,
  fontSize,
  fontWeight,
  opacity,
  spacing,
  useTheme,
} from "@/theme";
import { sizing } from "@/theme/sizing";

/**
 * The margin every printed block on the sheet is set to. Rules are the one thing
 * that ignores it — a rule runs the full width of the plate, which is what makes
 * the screen read as the sheet rather than as a column laid on one.
 */
export const authGutter = spacing[6];

const [titleMin, titleVw, titleMax] = displayClamp.c30_10_2_42;

/**
 * The foot is left to the scroll content instead of the safe area, so the
 * home-indicator inset is absorbed by the keyboard when it comes up rather than
 * holding a dead band open above the keys.
 */
const SAFE_EDGES = ["top", "left", "right"] as const;

/** The wash that holds the ink plate back far enough for type to sit on it. */
const SCRIM_STOPS = [
  "rgba(0,0,0,0.94)",
  "rgba(0,0,0,0.86)",
  "rgba(0,0,0,0.88)",
  "rgba(0,0,0,0.97)",
] as const;
const SCRIM_LOCATIONS = [0, 0.28, 0.6, 1] as const;

export interface AuthShellProps {
  children: ReactNode;
  description?: ReactNode;
  /** Marginalia set below the sheet's foot rule — the account switch, mostly. */
  footer?: ReactNode;
  /** Given when the screen was pushed: the rail grows a back control. */
  onBack?: () => void;
  title: string;
}

/** A block set to the sheet's margin. Rules stay outside it, full bleed. */
export function AuthBlock({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.block, style]}>{children}</View>;
}

/** A ruled line across the whole sheet. */
export function AuthRule() {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      pointerEvents="none"
      style={[styles.sheetRule, { backgroundColor: theme.colors.border }]}
    />
  );
}

/** A bare glyph target in the rail. Chrome, so it takes no plate of its own. */
function AuthRailAction({
  accessibilityLabel,
  name,
  onPress,
  testID,
}: {
  accessibilityLabel: string;
  name: IconName;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.railAction, pressed && styles.railActionPressed]}
      {...(testID === undefined ? {} : { testID })}
    >
      <Icon color="mutedForeground" name={name} size={sizing.control.icon} variant="chrome" />
    </Pressable>
  );
}

function BrandLockup() {
  const theme = useTheme();
  return (
    <View accessibilityLabel="spawnd" accessible style={styles.brandLockup}>
      <BrandMark color={theme.colors.brandAccent} size={spacing[5]} testID="auth-brand-mark" />
      <Wordmark color={theme.colors.brandAccent} height={spacing[4]} testID="auth-wordmark" />
    </View>
  );
}

/**
 * The rail every account screen wears: the lockup centred like a masthead, with
 * the screen's escape hatches hung either side of it. It is a navigation bar in
 * everything but name, which is the point — the account surface should read as
 * part of the app it opens onto, not as a page loaded inside it.
 */
function AuthRail({ onBack }: { onBack?: () => void }) {
  return (
    <View style={styles.rail}>
      <View style={styles.railSlot}>
        {onBack === undefined ? null : (
          <AuthRailAction
            accessibilityLabel="Back"
            name="ChevronLeft"
            onPress={onBack}
            testID="auth-back"
          />
        )}
      </View>
      <BrandLockup />
      {/* Balances the leading slot so the lockup stays optically centred. */}
      <View style={styles.railSlot} />
    </View>
  );
}

export function AuthShell({ children, description, footer, onBack, title }: AuthShellProps) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const titleSize = clampDisplay(width, titleMin, titleVw, titleMax);
  const enter = (index: number) =>
    FadeInDown.duration(duration.medium)
      .delay(index * duration.launcherItemStagger)
      .easing(easing.swift)
      .reduceMotion(ReduceMotion.System);

  return (
    <View style={[styles.ground, { backgroundColor: theme.colors.background }]} testID="auth-sheet">
      {theme.isDark ? (
        // The altar plate is ink. It belongs on a dark ground and nowhere else —
        // scrimmed onto a light one it is just a grey smudge, so a light sheet
        // is left as the paper the same press work is printed on.
        <>
          <Image
            accessibilityElementsHidden
            contentFit="cover"
            contentPosition={{ left: "50%", top: "32%" }}
            pointerEvents="none"
            source={require("../../../assets/images/altar-ink.png")}
            style={styles.backdrop}
            testID="auth-altar"
          />
          <LinearGradient
            accessibilityElementsHidden
            colors={SCRIM_STOPS}
            locations={SCRIM_LOCATIONS}
            pointerEvents="none"
            style={styles.scrim}
          />
        </>
      ) : null}
      <SafeAreaView edges={SAFE_EDGES} style={styles.safeArea}>
        <AuthRail {...(onBack === undefined ? {} : { onBack })} />
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.keyboardAvoider}
        >
          <ScrollView
            automaticallyAdjustKeyboardInsets
            contentContainerStyle={[
              styles.scrollContent,
              { paddingBottom: Math.max(insets.bottom, spacing[4]) },
            ]}
            contentInsetAdjustmentBehavior="never"
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Animated.View entering={enter(0)} style={styles.masthead}>
              <Text
                accessibilityRole="header"
                style={[
                  styles.title,
                  {
                    color: theme.colors.foreground,
                    fontSize: titleSize,
                    lineHeight: titleSize * displayLineHeightRatio.r102,
                  },
                ]}
              >
                {title}
              </Text>
              {description !== undefined ? (
                typeof description === "string" || typeof description === "number" ? (
                  <Text style={[styles.description, { color: theme.colors.mutedForeground }]}>
                    {description}
                  </Text>
                ) : (
                  description
                )
              ) : null}
            </Animated.View>
            <AuthRule />
            <Animated.View entering={enter(1)} style={styles.content}>
              {children}
            </Animated.View>
            <View style={styles.gap} />
            {footer === undefined ? null : (
              <Animated.View entering={enter(2)}>
                <AuthRule />
                <View style={styles.footer}>{footer}</View>
              </Animated.View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  block: {
    paddingHorizontal: authGutter,
  },
  brandLockup: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  content: {
    gap: spacing[6],
    // The sheet is bracketed by rules: one closing the masthead, one opening the
    // foot. What sits between them is the work.
    paddingTop: spacing[7],
  },
  description: {
    fontFamily: fontFamily.grimoireRegular,
    fontSize: fontSize.fifteen,
    lineHeight: spacing[6],
    marginTop: spacing[4],
    maxWidth: spacing[24] * 4,
  },
  footer: {
    paddingBottom: spacing[2],
    paddingHorizontal: authGutter,
    paddingTop: spacing[5],
  },
  gap: {
    flexGrow: 1,
    minHeight: spacing[8],
  },
  ground: {
    flex: 1,
  },
  keyboardAvoider: {
    flex: 1,
  },
  masthead: {
    paddingBottom: spacing[7],
    paddingHorizontal: authGutter,
    paddingTop: spacing[10],
  },
  rail: {
    alignItems: "center",
    flexDirection: "row",
    height: sizing.appHeader.minHeight,
    justifyContent: "space-between",
    paddingHorizontal: spacing[3],
  },
  railAction: {
    alignItems: "center",
    height: sizing.appHeader.actionTarget,
    justifyContent: "center",
    width: sizing.appHeader.actionTarget,
  },
  railActionPressed: {
    opacity: opacity.pressedContent,
  },
  railSlot: {
    minWidth: sizing.appHeader.sideSlot,
  },
  safeArea: {
    flex: 1,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
  },
  scrollContent: {
    flexGrow: 1,
  },
  sheetRule: {
    height: borderWidth.hairline,
    width: "100%",
  },
  title: {
    fontFamily: fontFamily.posterLight,
    fontWeight: fontWeight.light,
    textTransform: "uppercase",
  },
});
