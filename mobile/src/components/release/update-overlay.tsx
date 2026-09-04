import { useEffect, useSyncExternalStore } from "react";
import { Modal, Platform, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { BrandMark } from "@/components/brand/brand-mark";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { ToastProgressBar } from "@/components/ui/toast";
import { borderWidth, duration, easing, layer, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

let overlayOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): boolean {
  return overlayOpen;
}

/**
 * Whether the full-page update notice is up.
 *
 * Read by the persistent nav bar, the way it reads the camera. The bar is
 * portalled to window level, and a tab strip across the foot of a screen whose
 * whole point is that there is nowhere else to go reads as an offer the app
 * cannot keep.
 */
export function useUpdateOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

export interface UpdateOverlayAction {
  label: string;
  onPress: () => void;
  loading?: boolean;
}

export interface UpdateOverlayProps {
  title: string;
  body: string;
  /**
   * A bundle is being fetched right now. There is nothing to press while that
   * happens, so the actions give way to a bar that says "still going" — which
   * is the whole of what `expo-updates` reports, since it gives no progress.
   */
  busy?: boolean;
  primary?: UpdateOverlayAction;
  secondary?: UpdateOverlayAction;
  testID?: string;
}

/**
 * The app update, as the one thing on screen.
 *
 * Every state of the update path lands here: a downloaded bundle waiting to be
 * taken, a required one being fetched, and a build the server has stopped
 * speaking to that only a reinstall can fix. They are the same question asked
 * with different force, so they wear one face rather than three.
 *
 * It is a page and not a dialog. A dialog is a question raised over the thing
 * you were doing — and there is no going back to that here, because the answer
 * is always "the app is about to become a different one". It was a full-screen
 * Dialog for a while, and read as one: two lines of copy stranded at the top of
 * an empty sheet with the nav bar still promising three destinations across the
 * foot of it.
 */
export function UpdateOverlay({
  body,
  busy = false,
  primary,
  secondary,
  testID,
  title,
}: UpdateOverlayProps): React.JSX.Element {
  useEffect(() => {
    overlayOpen = true;
    emit();
    return () => {
      overlayOpen = false;
      emit();
    };
  }, []);

  const surface = (
    <UpdateOverlaySurface
      body={body}
      busy={busy}
      {...(primary === undefined ? {} : { primary })}
      {...(secondary === undefined ? {} : { secondary })}
      {...(testID === undefined ? {} : { testID })}
      title={title}
    />
  );

  // The nav bar lives in a window-level overlay, which renders above any RN
  // modal. Presenting into that same layer is what puts this over the bar
  // rather than behind it (`ui/sheet.tsx` does the same). Elsewhere a modal is
  // still the right container.
  if (Platform.OS === "ios") {
    return <FullWindowOverlay>{surface}</FullWindowOverlay>;
  }
  return (
    <Modal
      animationType="none"
      // Backing out is only ever the secondary action, and on a required
      // update there isn't one: the back gesture then does nothing, which is
      // the truth of the screen.
      onRequestClose={() => secondary?.onPress()}
      statusBarTranslucent
      transparent
      visible
    >
      {surface}
    </Modal>
  );
}

function UpdateOverlaySurface({
  body,
  busy,
  primary,
  secondary,
  testID,
  title,
}: Required<Pick<UpdateOverlayProps, "body" | "busy" | "title">> &
  Pick<UpdateOverlayProps, "primary" | "secondary" | "testID">): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const enter = (index: number) =>
    FadeInDown.duration(duration.medium)
      .delay(index * duration.launcherItemStagger)
      .easing(easing.swift)
      .reduceMotion(ReduceMotion.System);
  const hasActions = primary !== undefined || secondary !== undefined;

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      accessibilityViewIsModal
      style={[
        styles.ground,
        {
          backgroundColor: theme.colors.background,
          paddingBottom: Math.max(insets.bottom, spacing[6]),
          paddingHorizontal: spacing[6],
          paddingTop: insets.top + spacing[6],
          zIndex: layer.modal,
        },
      ]}
      testID={testID ?? "update-overlay"}
    >
      <Animated.View entering={enter(0)} style={[styles.body, { gap: theme.space(5) }]}>
        <View
          accessibilityElementsHidden
          style={[
            styles.plate,
            {
              backgroundColor: theme.colors.muted,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.xxl,
              borderWidth: borderWidth.hairline,
            },
          ]}
        >
          <BrandMark size={sizing.updateOverlay.mark} />
        </View>
        <View style={[styles.copy, { gap: theme.space(2) }]}>
          <Text accessibilityRole="header" style={styles.centered} variant="uiXl" weight="semibold">
            {title}
          </Text>
          <Text color="mutedForeground" style={styles.centered} variant="body">
            {body}
          </Text>
        </View>
        {busy ? (
          <View style={styles.progress}>
            <ToastProgressBar progress="indeterminate" />
          </View>
        ) : null}
      </Animated.View>
      {hasActions ? (
        <Animated.View entering={enter(1)} style={[styles.dock, { gap: theme.space(2) }]}>
          {primary === undefined ? null : (
            <Button
              loading={primary.loading === true}
              onPress={primary.onPress}
              size="lg"
              testID="update-overlay-primary"
            >
              {primary.label}
            </Button>
          )}
          {secondary === undefined ? null : (
            <Button
              onPress={secondary.onPress}
              size="lg"
              testID="update-overlay-secondary"
              variant="ghost"
            >
              {secondary.label}
            </Button>
          )}
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  centered: {
    textAlign: "center",
  },
  copy: {
    maxWidth: sizing.updateOverlay.contentMaxWidth,
  },
  dock: {
    alignSelf: "center",
    maxWidth: sizing.updateOverlay.contentMaxWidth,
    width: "100%",
  },
  ground: {
    ...StyleSheet.absoluteFillObject,
  },
  plate: {
    alignItems: "center",
    height: sizing.updateOverlay.plate,
    justifyContent: "center",
    width: sizing.updateOverlay.plate,
  },
  progress: {
    maxWidth: sizing.updateOverlay.contentMaxWidth,
    width: "100%",
  },
});
