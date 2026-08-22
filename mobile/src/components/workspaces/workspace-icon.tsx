import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";

import { Monogram } from "@/components/ui/monogram";
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

export async function pickWorkspaceIcon(): Promise<WorkspaceIconChoice | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ["image/png", "image/webp"],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  const mime = normalizeMime(asset.mimeType, asset.name);
  if (!mime) throw new Error("Choose a PNG or WebP image.");
  const base64 = await new File(asset.uri).base64();
  return { icon: workspaceIconDataUrl(mime, base64), iconSource: "custom" };
}

export function WorkspaceIcon({ icon, name, size, style, testID }: WorkspaceIconProps) {
  const theme = useTheme();
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
        transition={theme.motion.duration.base}
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
