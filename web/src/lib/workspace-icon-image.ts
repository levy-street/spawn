/**
 * Turning an image into a workspace's mark.
 *
 * Whatever the source — a favicon read off the host, a file the owner picked
 * off this device — it ends up as the same thing: a small square raster in a
 * `data:` URL the server will accept and the sidebar can draw without a second
 * request. Nothing is stored in its original form. An SVG is rasterized here
 * rather than kept as markup, and a 2 MB app icon is re-encoded rather than
 * carried around.
 *
 * The decisions live in `workspace-icon.ts`; this is the part that needs a
 * canvas.
 */

import { fitContain, isWorkspaceIcon, WORKSPACE_ICON_PIXELS } from "@/lib/workspace-icon";

/** How the browser is told to decode a file, since a host read carries no
 *  content type. An unlisted extension is not offered as a candidate. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  avif: "image/avif",
};

/**
 * Encodings to try, in order, stopping at the first that fits the server's
 * ceiling. WebP first — a 128px mark lands around 3 KB — with PNG as the
 * answer for browsers that decline to encode it (`toDataURL` quietly returns
 * a PNG when it cannot honour the type). The later rows trade edge and
 * quality rather than give up: an icon that is merely soft still beats the
 * monogram it replaced.
 */
const ENCODINGS: ReadonlyArray<{ pixels: number; type: string; quality: number }> = [
  { pixels: WORKSPACE_ICON_PIXELS, type: "image/webp", quality: 0.9 },
  { pixels: WORKSPACE_ICON_PIXELS, type: "image/png", quality: 1 },
  { pixels: 96, type: "image/webp", quality: 0.8 },
  { pixels: 96, type: "image/png", quality: 1 },
  { pixels: 64, type: "image/webp", quality: 0.7 },
  { pixels: 64, type: "image/png", quality: 1 },
];

export function iconMimeForName(name: string): string | null {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? null;
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    // Same-origin blob, but stating it keeps the canvas untainted on every
    // engine rather than most of them.
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    const settle = (finish: () => void) => {
      URL.revokeObjectURL(url);
      finish();
    };
    image.onload = () => settle(() => resolve(image));
    image.onerror = () => settle(() => reject(new Error("image could not be decoded")));
    image.src = url;
  });
}

function draw(image: HTMLImageElement, pixels: number): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = pixels;
  canvas.height = pixels;
  const context = canvas.getContext("2d");
  if (!context) return null;
  // No fill: transparency is preserved, so a mark drawn for a light page does
  // not arrive on a white slab in the dark theme.
  context.imageSmoothingQuality = "high";
  const box = fitContain(image.naturalWidth, image.naturalHeight, pixels);
  context.drawImage(image, box.x, box.y, box.width, box.height);
  return canvas;
}

/** Whether anything was actually drawn. Also the earliest point a tainted
 *  canvas gives itself away, which is why it answers false rather than
 *  throwing: either way there is no icon here. */
function hasVisiblePixels(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d");
  if (!context) return false;
  try {
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * `blob` as a stored-shape icon, or null if it is not an image this browser
 * can decode, if it draws nothing, or if the canvas refuses to give the pixels
 * back (a tainted canvas throws rather than returning anything).
 */
export async function renderWorkspaceIcon(blob: Blob): Promise<string | null> {
  let image: HTMLImageElement;
  try {
    image = await loadImage(blob);
  } catch {
    return null;
  }
  for (const { pixels, type, quality } of ENCODINGS) {
    const canvas = draw(image, pixels);
    if (!canvas) return null;
    // An image can load and still draw nothing — an SVG whose only size is a
    // viewBox on an engine that declines to scale it, a file that is an image
    // in name only. A blank square in the sidebar is worse than the monogram
    // it replaced, so it counts as no icon and the scan moves to the next
    // candidate.
    if (!hasVisiblePixels(canvas)) return null;
    let encoded: string;
    try {
      encoded = canvas.toDataURL(type, quality);
    } catch {
      // Tainted: nothing further will work on this image either.
      return null;
    }
    // Covers both halves of "storable": the right kind of data URL, and small
    // enough that the server will take it.
    if (isWorkspaceIcon(encoded)) return encoded;
  }
  // Every attempt overshot — an icon we cannot store is no icon.
  return null;
}

/** A file chosen from this device. Anything the browser calls an image is
 *  allowed in: the render is what decides whether it can be used. */
export function renderWorkspaceIconFromFile(file: File): Promise<string | null> {
  return renderWorkspaceIcon(file);
}
