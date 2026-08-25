import { useRouter } from "expo-router";
import { useMemo } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS, withSpring } from "react-native-reanimated";
import { AuthLink, authFooterRow } from "@/components/auth/auth-actions";
import { AuthMessage } from "@/components/auth/auth-message";
import { AuthBlock, AuthShell } from "@/components/auth/auth-shell";
import { MARK_SIZE, OAuthButtons, SignInOptionButton } from "@/components/auth/oauth-buttons";
import { useServerPicker } from "@/components/auth/server-picker";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useTabSwipe } from "@/components/ui/underline-tabs";
import { useAuthConfigQuery } from "@/data/queries/auth";
import { spacing } from "@/theme";

export { validateLoginForm } from "@/components/auth/email-login-form";

/** Sideways travel before the sheet starts following a swipe. */
const SWIPE_ACTIVATION = 16;
/** Vertical slack that hands the touch back to the sheet's own scrolling. */
const SWIPE_AXIS_SLOP = 12;
/** Fraction of the width past which a release changes tab. */
const SWIPE_COMMIT_RATIO = 0.25;
/** How far ahead of the finger a release is read, so a flick commits early. */
const SWIPE_PROJECTION_SECONDS = 0.15;
const SETTLE_SPRING = { damping: 24, mass: 0.6, stiffness: 260 } as const;

/**
 * The way in. Which server first, at the very top; then how, docked at the
 * foot where the thumb is: email, then the account buttons the platforms draw,
 * Apple's filled slab last.
 */
export function LoginScreen() {
  const router = useRouter();
  const configQuery = useAuthConfigQuery();
  const { width: pageWidth } = useWindowDimensions();
  /** A swipe in progress, carried up to the strip's indicator and finished there. */
  const swipe = useTabSwipe();
  const server = useServerPicker({ swipe });
  const { step } = server;

  // The sheet is the page the tabs head, so it swipes between them the way a
  // paged view does — the indicator following the finger, and letting go past
  // a quarter of the width, or with a flick, changing the tab. A release that
  // changes the tab hands the finger's travel and speed to the strip, which
  // settles once, with that speed; only a release that changes nothing is
  // sprung back from here.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-SWIPE_ACTIVATION, SWIPE_ACTIVATION])
        .failOffsetY([-SWIPE_AXIS_SLOP, SWIPE_AXIS_SLOP])
        .onUpdate((event) => {
          "worklet";
          swipe.drift.value = Math.max(-1, Math.min(1, -event.translationX / pageWidth));
        })
        .onEnd((event) => {
          "worklet";
          const projected = event.translationX + event.velocityX * SWIPE_PROJECTION_SECONDS;
          const velocity = -event.velocityX / pageWidth;
          const threshold = pageWidth * SWIPE_COMMIT_RATIO;
          const delta = projected < -threshold ? 1 : projected > threshold ? -1 : 0;
          if (delta === 0) {
            swipe.drift.value = withSpring(0, { ...SETTLE_SPRING, velocity });
            return;
          }
          swipe.velocity.value = velocity;
          runOnJS(step)(delta);
        }),
    [pageWidth, step, swipe],
  );

  return (
    <GestureDetector gesture={pan}>
      {/* The detector needs a native view of its own to attach to. */}
      <View collapsable={false} style={styles.page}>
        <AuthShell
          brand
          description="Host your daemons, reach them from anywhere."
          // Nothing to sign in to yet: on the self-hosted tab the ways in, and the
          // account link with them, wait until the server has answered.
          dock={
            server.ready ? (
              <View style={styles.options}>
                <OAuthButtons
                  loading={configQuery.isPending}
                  providers={configQuery.data?.providers ?? []}
                />
                {/* Email closes the set as the filled slab: the way in that
                    works on every server, whatever providers it lists. */}
                <AuthBlock>
                  <SignInOptionButton
                    icon={<Icon color="primaryForeground" name="Mail" size={MARK_SIZE} />}
                    label="Continue with email"
                    onPress={() => router.push("/login-email")}
                    testID="login-email-option"
                    tone="ink"
                  />
                </AuthBlock>
              </View>
            ) : undefined
          }
          footer={
            server.ready ? (
              <View style={authFooterRow}>
                <Text color="mutedForeground" variant="sigilLabel">
                  Don’t have an account?
                </Text>
                <AuthLink emphasis label="Create one" onPress={() => router.push("/signup")} />
              </View>
            ) : undefined
          }
          lead={server.tabs}
          title="Enter the circle"
        >
          {server.field === null ? null : <AuthBlock>{server.field}</AuthBlock>}
          {configQuery.isError ? (
            <AuthMessage tone="error">
              The server did not answer with its sign-in options. Email sign-in still works.
            </AuthMessage>
          ) : null}
        </AuthShell>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  options: {
    gap: spacing[3],
  },
  page: {
    flex: 1,
  },
});
