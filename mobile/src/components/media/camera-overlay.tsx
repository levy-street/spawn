import { useEffect, useRef, useState } from "react";
import { Keyboard, Linking, Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { PickedImage } from "@/components/media/image-source";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, FixedThemeProvider, layer, opacity, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/** The shutter's plate, and the ring drawn around it. */
const SHUTTER = spacing[16];
const SHUTTER_RING = spacing[20];
/** The JPEG quality a captured frame is kept at. */
const CAPTURE_QUALITY = 0.9;

export interface CameraOverlayProps {
  visible: boolean;
  onCapture: (picture: PickedImage) => void;
  onClose: () => void;
}

/**
 * The camera, as the one thing on screen.
 *
 * The system picker presented itself as a modal *under* the window-level
 * overlays — the nav bar sat across the bottom of the viewfinder, and a drawer
 * or a knock could open on top of it. This is a presented full-screen modal of
 * the app's own, with the nav bar stepping aside for as long as it is up
 * (`camera-host.tsx`): the viewfinder, a close control, a shutter, nothing else,
 * until it is closed or a photo is taken. It was a window-level overlay for a
 * while, but the live preview climbed above the controls drawn over it once
 * the session started, and a camera that cannot be closed is worse than one
 * under a nav bar.
 */
export function CameraOverlay({
  visible,
  onCapture,
  onClose,
}: CameraOverlayProps): React.JSX.Element | null {
  if (!visible) return null;

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      statusBarTranslucent
      visible
    >
      {/* Camera chrome is always ink on black: the viewfinder is the ground. */}
      <FixedThemeProvider mode="dark">
        <CameraSurface onCapture={onCapture} onClose={onClose} />
      </FixedThemeProvider>
    </Modal>
  );
}

function CameraSurface({
  onCapture,
  onClose,
}: Omit<CameraOverlayProps, "visible">): React.JSX.Element {
  // Loaded when the camera is opened, not when the app is: the native module
  // has no business in the startup path or in every screen's tests.
  const { CameraView, useCameraPermissions } =
    require("expo-camera") as typeof import("expo-camera");
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef<InstanceType<typeof CameraView>>(null);

  useEffect(() => {
    Keyboard.dismiss();
  }, []);

  const granted = permission?.granted === true;
  const canAsk = permission?.canAskAgain !== false;
  useEffect(() => {
    if (permission && !granted && canAsk) void requestPermission();
  }, [canAsk, granted, permission, requestPermission]);

  const capture = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: CAPTURE_QUALITY });
      if (!photo) return;
      haptics.success();
      onCapture({ uri: photo.uri, name: "photo.jpg", mimeType: "image/jpeg" });
    } catch {
      haptics.error();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.scrim }]} testID="camera-overlay">
      {granted ? (
        <CameraView facing={facing} ref={cameraRef} style={StyleSheet.absoluteFill} />
      ) : (
        <View style={[styles.refused, { paddingHorizontal: spacing[6] }]}>
          <Text style={styles.centered} variant="uiLg" weight="semibold">
            {permission === null ? "Opening the camera…" : "SPAWN D needs camera access"}
          </Text>
          {permission !== null && !canAsk ? (
            <>
              <Text color="mutedForeground" style={styles.centered} variant="body">
                Camera access is turned off for SPAWN D in the system Settings.
              </Text>
              <Button onPress={() => void Linking.openSettings()} variant="outline">
                Open system Settings
              </Button>
            </>
          ) : null}
        </View>
      )}

      <View
        pointerEvents="box-none"
        style={[styles.chrome, { paddingTop: insets.top + spacing[2], zIndex: layer.modal }]}
      >
        <View style={[styles.plate, { backgroundColor: theme.colors.muted }]}>
          <IconButton
            accessibilityLabel="Close camera"
            icon="X"
            onPress={onClose}
            size="lg"
            testID="camera-close"
          />
        </View>
      </View>

      <View
        pointerEvents="box-none"
        style={[
          styles.controls,
          { paddingBottom: insets.bottom + spacing[6], zIndex: layer.modal },
        ]}
      >
        <View style={[styles.plate, { backgroundColor: theme.colors.muted }]}>
          <IconButton
            accessibilityLabel="Switch camera"
            disabled={!granted}
            icon="SwitchCamera"
            onPress={() => setFacing((current) => (current === "back" ? "front" : "back"))}
            size="lg"
            testID="camera-flip"
          />
        </View>
        <Pressable
          accessibilityLabel="Take photo"
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: !granted }}
          disabled={!granted || busy}
          onPress={() => {
            void capture();
          }}
          style={({ pressed }) => [
            styles.ring,
            {
              borderColor: theme.colors.foreground,
              opacity: granted ? opacity.opaque : opacity.disabled,
            },
            pressed && styles.ringPressed,
          ]}
          testID="camera-shutter"
        >
          <View style={[styles.shutter, { backgroundColor: theme.colors.foreground }]} />
        </Pressable>
        {/* Balances the flip control so the shutter sits dead centre. */}
        <View style={styles.plateGhost} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    textAlign: "center",
  },
  chrome: {
    alignItems: "flex-end",
    left: 0,
    paddingHorizontal: spacing[3],
    position: "absolute",
    right: 0,
    top: 0,
  },
  controls: {
    alignItems: "center",
    bottom: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    left: 0,
    paddingHorizontal: spacing[8],
    position: "absolute",
    right: 0,
  },
  plate: {
    alignItems: "center",
    borderRadius: sizing.control.iconButton.prominent,
    height: sizing.control.iconButton.prominent,
    justifyContent: "center",
    opacity: opacity.hoverButton,
    width: sizing.control.iconButton.prominent,
  },
  plateGhost: {
    height: sizing.control.iconButton.prominent,
    width: sizing.control.iconButton.prominent,
  },
  refused: {
    alignItems: "center",
    flex: 1,
    gap: spacing[4],
    justifyContent: "center",
  },
  ring: {
    alignItems: "center",
    borderRadius: SHUTTER_RING,
    borderWidth: borderWidth.poster,
    height: SHUTTER_RING,
    justifyContent: "center",
    width: SHUTTER_RING,
  },
  ringPressed: {
    transform: [{ scale: 0.94 }],
  },
  root: {
    flex: 1,
  },
  shutter: {
    borderRadius: SHUTTER,
    height: SHUTTER,
    width: SHUTTER,
  },
});
