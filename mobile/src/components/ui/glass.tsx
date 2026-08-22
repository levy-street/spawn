import { type BlurTint, BlurView } from "expo-blur";
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  type StyleProp,
  StyleSheet,
  type ViewStyle,
} from "react-native";

import { useTheme } from "@/theme";

export interface GlassSurfaceProps {
  children: ReactNode;
  intensity?: "chrome" | "thin" | "ultraThin";
  style?: StyleProp<ViewStyle>;
}

type GlassIntensity = NonNullable<GlassSurfaceProps["intensity"]>;

const BLUR_INTENSITY: Record<GlassIntensity, number> = {
  chrome: 92,
  thin: 86,
  ultraThin: 72,
};

const BLUR_MATERIAL: Record<
  GlassIntensity,
  "systemChromeMaterial" | "systemThinMaterial" | "systemUltraThinMaterial"
> = {
  chrome: "systemChromeMaterial",
  thin: "systemThinMaterial",
  ultraThin: "systemUltraThinMaterial",
};

let reduceTransparencyEnabled: boolean | null = null;

/**
 * The accessibility query is asynchronous, so availability stays conservative until a
 * GlassSurface has resolved it. Callers never mistake an unknown state for usable glass.
 */
export function isGlassAvailable(): boolean {
  if (Platform.OS !== "ios" || reduceTransparencyEnabled !== false) return false;

  try {
    return isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
  } catch {
    return false;
  }
}

function blurTint(intensity: GlassIntensity, dark: boolean): BlurTint {
  const appearance = dark ? "Dark" : "Light";
  return `${BLUR_MATERIAL[intensity]}${appearance}` as BlurTint;
}

function useGlassAvailability(): boolean {
  const [available, setAvailable] = useState(isGlassAvailable);

  useEffect(() => {
    let mounted = true;

    const update = (enabled: boolean) => {
      reduceTransparencyEnabled = enabled;
      if (mounted) setAvailable(isGlassAvailable());
    };

    void AccessibilityInfo.isReduceTransparencyEnabled().then(update, () => update(true));
    const subscription = AccessibilityInfo.addEventListener("reduceTransparencyChanged", update);

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return available;
}

export function GlassSurface({
  children,
  intensity = "chrome",
  style,
}: GlassSurfaceProps): React.JSX.Element {
  const theme = useTheme();
  const available = useGlassAvailability();

  if (available) {
    return (
      <GlassView
        colorScheme={theme.isDark ? "dark" : "light"}
        glassEffectStyle="regular"
        style={[styles.surface, style]}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <BlurView
      intensity={BLUR_INTENSITY[intensity]}
      style={[styles.surface, style]}
      tint={blurTint(intensity, theme.isDark)}
    >
      {children}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  surface: {
    overflow: "hidden",
  },
});
