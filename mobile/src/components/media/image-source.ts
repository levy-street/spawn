import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";

/** The three ways a phone holds a picture. Every image input offers all three. */
export type ImageSource = "camera" | "photos" | "files";

export interface PickedImage {
  uri: string;
  name: string;
  mimeType: string | null;
}

export interface PickImageOptions {
  /**
   * Document-picker MIME filter for the "files" source. Defaults to any image;
   * the terminal widens it, since a session accepts any file at all.
   */
  fileTypes?: string | string[];
}

function assetName(asset: ImagePicker.ImagePickerAsset, fallback: string): string {
  if (asset.fileName && asset.fileName.length > 0) return asset.fileName;
  const extension = asset.uri.split(".").pop();
  return extension && /^[A-Za-z0-9]{1,5}$/.test(extension)
    ? `${fallback}.${extension.toLowerCase()}`
    : fallback;
}

/**
 * Resolves one image, or null when the operator backed out.
 *
 * Permission is asked for at the point of use rather than up front, so a refusal
 * explains itself against the thing that was just tapped.
 */
export async function pickImage(
  source: ImageSource,
  { fileTypes = "image/*" }: PickImageOptions = {},
): Promise<PickedImage | null> {
  if (source === "files") {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: fileTypes,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    return asset ? { uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null } : null;
  }

  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error("spawn needs camera access to take a photo.");
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
    const asset = result.canceled ? undefined : result.assets[0];
    return asset
      ? {
          uri: asset.uri,
          name: assetName(asset, "photo.jpg"),
          mimeType: asset.mimeType ?? "image/jpeg",
        }
      : null;
  }

  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error("spawn needs photo access to upload from your library.");
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.9,
    selectionLimit: 1,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  return asset
    ? {
        uri: asset.uri,
        name: assetName(asset, "image.jpg"),
        mimeType: asset.mimeType ?? "image/jpeg",
      }
    : null;
}
