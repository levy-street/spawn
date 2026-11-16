import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { Input } from "@/components/ui/input";
import { type Hsv, hexToHsv, hsvToHex, parseHex } from "@/data/color";
import { borderWidth, shadow, useTheme, withAlpha } from "@/theme";
import { sizing } from "@/theme/sizing";

/** One press of an adjustable control: five per cent of saturation or brightness. */
const SV_STEP = 0.05;
/** One press on the hue bar, in degrees. */
const HUE_STEP = 10;
const FULL_TURN = 360;
const HUE_STOPS = [0, 60, 120, 180, 240, 300, 360];
const PERCENT = 100;
const SQUARE_HEIGHT = sizing.colorPicker.squareHeight;
const THUMB_OFFSET = sizing.colorPicker.thumb / 2;

export interface ColorPickerProps {
  /** The colour shown, as `#rrggbb`. */
  value: string;
  /** Every change, as lowercase `#rrggbb`: while dragging, on each step, on a valid hex. */
  onChange: (hex: string) => void;
  /**
   * A thumb is being dragged, or has been let go. A scrolling container turns
   * its own scroll off meanwhile, so a vertical drag moves the thumb, not the page.
   */
  onActiveChange?: (active: boolean) => void;
  testID?: string;
}

function clamp01(value: number): number {
  "worklet";
  return Math.min(Math.max(value, 0), 1);
}

function wrapHue(hue: number): number {
  return ((hue % FULL_TURN) + FULL_TURN) % FULL_TURN;
}

function percent(value: number): number {
  return Math.round(value * PERCENT);
}

/**
 * A colour as hue, saturation and brightness: a square for the last two over
 * the current hue, a bar for the hue, and the hex for anyone who knows the one
 * they want.
 *
 * The thumbs are shared values written by the pan gestures on the UI thread,
 * so they follow the finger without a render; each move also reports the
 * colour back to JS, which repaints the square's hue and calls `onChange`.
 * The square and the bar are adjustable controls too: increment and decrement
 * step brightness and hue, and the square offers saturation as named actions.
 */
export function ColorPicker({
  value,
  onChange,
  onActiveChange,
  testID = "color-picker",
}: ColorPickerProps) {
  const theme = useTheme();
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? { h: 0, s: 0, v: 0 });
  const [hexDraft, setHexDraft] = useState(value);
  const [width, setWidth] = useState(0);
  const hue = useSharedValue(hsv.h);
  const saturation = useSharedValue(hsv.s);
  const brightness = useSharedValue(hsv.v);
  const trackWidth = useSharedValue(0);
  const hex = hsvToHex(hsv);
  // What this picker last reported, so its own change coming back as `value`
  // does not reset the hue a grey has no opinion about.
  const reportedRef = useRef(hex);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const reportActive = useCallback((active: boolean) => onActiveChangeRef.current?.(active), []);

  const apply = useCallback(
    (next: Hsv) => {
      hue.value = next.h;
      saturation.value = next.s;
      brightness.value = next.v;
      setHsv(next);
      const nextHex = hsvToHex(next);
      setHexDraft(nextHex);
      reportedRef.current = nextHex;
      onChangeRef.current(nextHex);
    },
    [brightness, hue, saturation],
  );

  /** Reported from the UI thread while a thumb is dragged. */
  const applyFromGesture = useCallback(
    (h: number, s: number, v: number) => apply({ h, s, v }),
    [apply],
  );

  useEffect(() => {
    const parsed = parseHex(value);
    if (!parsed || parsed === reportedRef.current) return;
    const next = hexToHsv(parsed);
    if (!next) return;
    reportedRef.current = parsed;
    // A grey or black carries no hue; keep the one already chosen.
    const h = next.s === 0 || next.v === 0 ? hue.value : next.h;
    hue.value = h;
    saturation.value = next.s;
    brightness.value = next.v;
    setHsv({ ...next, h });
    setHexDraft(parsed);
  }, [brightness, hue, saturation, value]);

  const onTrackLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = event.nativeEvent.layout.width;
      trackWidth.value = measured;
      setWidth(measured);
    },
    [trackWidth],
  );

  const squareGesture = useMemo(() => {
    const track = (x: number, y: number) => {
      "worklet";
      if (trackWidth.value <= 0) return;
      saturation.value = clamp01(x / trackWidth.value);
      brightness.value = 1 - clamp01(y / SQUARE_HEIGHT);
      scheduleOnRN(applyFromGesture, hue.value, saturation.value, brightness.value);
    };
    return Gesture.Pan()
      .withTestId(`${testID}-square-pan`)
      .minDistance(0)
      .maxPointers(1)
      .onBegin((event) => {
        scheduleOnRN(reportActive, true);
        track(event.x, event.y);
      })
      .onUpdate((event) => track(event.x, event.y))
      .onFinalize(() => scheduleOnRN(reportActive, false));
  }, [applyFromGesture, brightness, hue, reportActive, saturation, testID, trackWidth]);

  const hueGesture = useMemo(() => {
    const track = (x: number) => {
      "worklet";
      if (trackWidth.value <= 0) return;
      // The bar's right end is 360°, which is red again; keep it short of a full turn.
      hue.value = Math.min(clamp01(x / trackWidth.value) * FULL_TURN, FULL_TURN - 1);
      scheduleOnRN(applyFromGesture, hue.value, saturation.value, brightness.value);
    };
    return Gesture.Pan()
      .withTestId(`${testID}-hue-pan`)
      .minDistance(0)
      .maxPointers(1)
      .onBegin((event) => {
        scheduleOnRN(reportActive, true);
        track(event.x);
      })
      .onUpdate((event) => track(event.x))
      .onFinalize(() => scheduleOnRN(reportActive, false));
  }, [applyFromGesture, brightness, hue, reportActive, saturation, testID, trackWidth]);

  const squareThumbStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: saturation.value * trackWidth.value - THUMB_OFFSET },
      { translateY: (1 - brightness.value) * SQUARE_HEIGHT - THUMB_OFFSET },
    ],
  }));
  const hueThumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (hue.value / FULL_TURN) * trackWidth.value - THUMB_OFFSET }],
  }));

  const white = hsvToHex({ h: 0, s: 0, v: 1 });
  const black = hsvToHex({ h: 0, s: 0, v: 0 });
  const pureHue = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const hueColors = HUE_STOPS.map((stop) => hsvToHex({ h: stop, s: 1, v: 1 }));
  const thumbChrome = {
    borderColor: white,
    borderRadius: theme.radii.pill,
    borderWidth: sizing.colorPicker.thumbBorder,
    boxShadow: shadow.sm,
  };

  return (
    <View onLayout={onTrackLayout} style={styles.picker} testID={testID}>
      <GestureDetector gesture={squareGesture}>
        <View
          accessibilityActions={[
            { name: "increment", label: "Brighter" },
            { name: "decrement", label: "Darker" },
            { name: "moreSaturated", label: "More saturated" },
            { name: "lessSaturated", label: "Less saturated" },
          ]}
          accessibilityLabel="Saturation and brightness"
          accessibilityRole="adjustable"
          accessibilityValue={{
            text: `Saturation ${percent(hsv.s)}%, brightness ${percent(hsv.v)}%`,
          }}
          accessible
          onAccessibilityAction={(event) => {
            switch (event.nativeEvent.actionName) {
              case "increment":
                apply({ ...hsv, v: clamp01(hsv.v + SV_STEP) });
                break;
              case "decrement":
                apply({ ...hsv, v: clamp01(hsv.v - SV_STEP) });
                break;
              case "moreSaturated":
                apply({ ...hsv, s: clamp01(hsv.s + SV_STEP) });
                break;
              case "lessSaturated":
                apply({ ...hsv, s: clamp01(hsv.s - SV_STEP) });
                break;
            }
          }}
          style={[
            styles.square,
            { backgroundColor: pureHue, borderRadius: theme.radii.md, height: SQUARE_HEIGHT },
          ]}
          testID={`${testID}-square`}
        >
          <LinearGradient
            colors={[white, withAlpha(white, 0)]}
            end={{ x: 1, y: 0 }}
            pointerEvents="none"
            start={{ x: 0, y: 0 }}
            style={[StyleSheet.absoluteFill, { borderRadius: theme.radii.md }]}
          />
          <LinearGradient
            colors={[withAlpha(black, 0), black]}
            end={{ x: 0, y: 1 }}
            pointerEvents="none"
            start={{ x: 0, y: 0 }}
            style={[StyleSheet.absoluteFill, { borderRadius: theme.radii.md }]}
          />
          {width > 0 ? (
            <Animated.View
              pointerEvents="none"
              style={[styles.thumb, thumbChrome, { backgroundColor: hex }, squareThumbStyle]}
              testID={`${testID}-square-thumb`}
            />
          ) : null}
        </View>
      </GestureDetector>
      <GestureDetector gesture={hueGesture}>
        <View
          accessibilityActions={[
            { name: "increment", label: "Next hue" },
            { name: "decrement", label: "Previous hue" },
          ]}
          accessibilityLabel="Hue"
          accessibilityRole="adjustable"
          accessibilityValue={{ text: `${Math.round(hsv.h)} degrees` }}
          accessible
          onAccessibilityAction={(event) => {
            const step =
              event.nativeEvent.actionName === "increment"
                ? HUE_STEP
                : event.nativeEvent.actionName === "decrement"
                  ? -HUE_STEP
                  : 0;
            if (step !== 0) apply({ ...hsv, h: wrapHue(hsv.h + step) });
          }}
          style={styles.hueTrack}
          testID={`${testID}-hue`}
        >
          <LinearGradient
            colors={hueColors as [string, string, ...string[]]}
            end={{ x: 1, y: 0 }}
            pointerEvents="none"
            start={{ x: 0, y: 0 }}
            style={[styles.hueBar, { borderRadius: theme.radii.pill }]}
          />
          {width > 0 ? (
            <Animated.View
              pointerEvents="none"
              style={[styles.thumb, thumbChrome, { backgroundColor: pureHue }, hueThumbStyle]}
              testID={`${testID}-hue-thumb`}
            />
          ) : null}
        </View>
      </GestureDetector>
      <Input
        accessibilityLabel="Hex"
        autoCapitalize="none"
        maxLength={7}
        onBlur={() => setHexDraft(hex)}
        onChangeText={(text) => {
          setHexDraft(text);
          const parsed = parseHex(text);
          const next = parsed ? hexToHsv(parsed) : null;
          if (!parsed || !next || parsed === hex) return;
          apply({ ...next, h: next.s === 0 || next.v === 0 ? hsv.h : next.h });
        }}
        placeholder="#rrggbb"
        testID={`${testID}-hex`}
        value={hexDraft}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hueBar: {
    height: sizing.colorPicker.hueHeight,
    width: "100%",
  },
  hueTrack: {
    height: sizing.colorPicker.thumb,
    justifyContent: "center",
    position: "relative",
    width: "100%",
  },
  picker: {
    gap: sizing.space.cluster,
    width: "100%",
  },
  square: {
    borderWidth: borderWidth.none,
    overflow: "visible",
    position: "relative",
    width: "100%",
  },
  thumb: {
    height: sizing.colorPicker.thumb,
    left: 0,
    position: "absolute",
    top: 0,
    width: sizing.colorPicker.thumb,
  },
});
