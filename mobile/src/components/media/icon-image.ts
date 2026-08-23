import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

/**
 * The server accepts a workspace or template icon only as a base64 PNG or WebP
 * data URL of at most 32 KiB, which no camera photo is. Rather than refusing
 * every source but a hand-made file, an image is re-encoded to fit: square-ish
 * PNG at the largest of these edges that lands inside the budget.
 *
 * Icons are drawn at 32–48pt, so even the smallest edge here is oversampled on a
 * 3x display. PNG rather than WebP because WebP encoding is Android-only.
 */
const ICON_EDGES = [128, 96, 72, 48] as const;

export async function encodeIconDataUrl(uri: string, maxCharacters: number): Promise<string> {
  let smallest: string | null = null;

  for (const edge of ICON_EDGES) {
    const context = ImageManipulator.manipulate(uri).resize({ width: edge, height: edge });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ base64: true, format: SaveFormat.PNG });
    if (saved.base64 === undefined) continue;
    const dataUrl = `data:image/png;base64,${saved.base64.replaceAll(/\s/g, "")}`;
    smallest = dataUrl;
    if (dataUrl.length <= maxCharacters) return dataUrl;
  }

  throw new Error(
    smallest === null
      ? "That image could not be read."
      : "That image is too detailed to use as an icon. Try a simpler one.",
  );
}
