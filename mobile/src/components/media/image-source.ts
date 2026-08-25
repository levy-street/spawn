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
  /**
   * Lets the operator take several in one visit to the picker. An input that
   * holds exactly one picture — a workspace icon, a template — leaves this off;
   * the terminal, which is a queue, turns it on. The camera takes one shot
   * either way.
   */
  multiple?: boolean;
}

function assetName(asset: ImagePicker.ImagePickerAsset, fallback: string): string {
  if (asset.fileName && asset.fileName.length > 0) return asset.fileName;
  const extension = asset.uri.split(".").pop();
  return extension && /^[A-Za-z0-9]{1,5}$/.test(extension)
    ? `${fallback}.${extension.toLowerCase()}`
    : fallback;
}

/**
 * Resolves every image the operator chose, or an empty list when they backed out.
 *
 * Permission is asked for at the point of use rather than up front, so a refusal
 * explains itself against the thing that was just tapped. The camera is the
 * app's own overlay (`camera-overlay.tsx`), which stands over the nav bar and
 * every drawer; the system picker sat underneath them.
 */
export async function pickImages(
  source: ImageSource,
  { fileTypes = "image/*", multiple = false }: PickImageOptions = {},
): Promise<PickedImage[]> {
  if (source === "files") {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple,
      type: fileTypes,
    });
    if (result.canceled) return [];
    return result.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType ?? null,
    }));
  }

  if (source === "camera") {
    // Loaded here rather than at the top: the host is a React component tree,
    // and this module is imported by plain data code.
    const { captureWithCamera } =
      require("@/components/media/camera-host") as typeof import("@/components/media/camera-host");
    // One shutter press is one picture; "multiple" has nothing to say here.
    const captured = await captureWithCamera();
    return captured ? [captured] : [];
  }

  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted)
    throw new Error("SPAWN D needs photo access to upload from your library.");
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.9,
    // 0 is the picker's word for "as many as you like".
    selectionLimit: multiple ? 0 : 1,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: assetName(asset, "image.jpg"),
    mimeType: asset.mimeType ?? "image/jpeg",
  }));
}

/** The single-image door onto {@link pickImages}, for inputs that hold one. */
export async function pickImage(
  source: ImageSource,
  options: PickImageOptions = {},
): Promise<PickedImage | null> {
  const [first] = await pickImages(source, { ...options, multiple: false });
  return first ?? null;
}
