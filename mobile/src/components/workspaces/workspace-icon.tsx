import { File } from "expo-file-system";
import { Image } from "expo-image";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";

import { encodeIconDataUrl } from "@/components/media/icon-image";
import { type ImageSource, pickImage } from "@/components/media/image-source";
import { Monogram } from "@/components/ui/monogram";
import { useReducedMotion } from "@/lib/motion/reduced-motion";
import { borderWidth, useTheme } from "@/theme";

export const WORKSPACE_ICON_MAX_CHARACTERS = 32 * 1024;

type WorkspaceIconMime = "image/png" | "image/webp";

export interface WorkspaceIconChoice {
  icon: string | null;
  iconSource: "custom";
}

export interface WorkspaceIconProps {
  icon: string | null;
  name: string;
  size: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function normalizeMime(
  mimeType: string | null | undefined,
  name: string,
): WorkspaceIconMime | null {
  const normalized = mimeType?.toLowerCase();
  if (normalized === "image/png" || normalized === "image/webp") return normalized;
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".webp")) return "image/webp";
  return null;
}

export function workspaceIconDataUrl(mime: WorkspaceIconMime, base64: string): string {
  const value = `data:${mime};base64,${base64.replaceAll(/\s/g, "")}`;
  if (value.length > WORKSPACE_ICON_MAX_CHARACTERS) {
    throw new Error("Choose a smaller PNG or WebP. Icons are limited to 32 KiB of encoded data.");
  }
  return value;
}

export function initialsWorkspaceIcon(): WorkspaceIconChoice {
  return { icon: null, iconSource: "custom" };
}

/**
 * Resolves an icon from any of the app's image sources.
 *
 * A PNG or WebP that already fits the budget is used as it is — a hand-made icon
 * should not be re-encoded. Anything else, a camera photo above all, is squared
 * down to a PNG that fits, because the server takes nothing else.
 */
export async function pickWorkspaceIcon(source: ImageSource): Promise<WorkspaceIconChoice | null> {
  const picked = await pickImage(source, { fileTypes: ["image/png", "image/webp"] });
  if (!picked) return null;

  const mime = normalizeMime(picked.mimeType, picked.name);
  if (mime !== null) {
    const base64 = await new File(picked.uri).base64();
    const direct = `data:${mime};base64,${base64.replaceAll(/\s/g, "")}`;
    if (direct.length <= WORKSPACE_ICON_MAX_CHARACTERS) {
      return { icon: direct, iconSource: "custom" };
    }
  }

  return {
    icon: await encodeIconDataUrl(picked.uri, WORKSPACE_ICON_MAX_CHARACTERS),
    iconSource: "custom",
  };
}

export function WorkspaceIcon({ icon, name, size, style, testID }: WorkspaceIconProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  if (!icon) {
    return (
      <Monogram
        seed={name}
        size={size}
        {...(style === undefined ? {} : { style })}
        {...(testID === undefined ? {} : { testID })}
      />
    );
  }

  return (
    <View
      accessibilityLabel={`${name} workspace icon`}
      accessibilityRole="image"
      style={[
        styles.imageFrame,
        {
          backgroundColor: theme.colors.muted,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          height: size,
          width: size,
        },
        style,
      ]}
      testID={testID}
    >
      <Image
        contentFit="cover"
        source={{ uri: icon }}
        style={StyleSheet.absoluteFill}
        transition={reducedMotion ? theme.motion.duration.instant : theme.motion.duration.base}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  imageFrame: {
    borderWidth: borderWidth.hairline,
    overflow: "hidden",
  },
});
