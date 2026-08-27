import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pngToIco from "png-to-ico";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const master = join(here, "icon.png");
const checkOnly = process.argv.includes("--check");
// Put the 32 px layer first: Windows uses it for development and several
// shell surfaces, while the rest cover high-DPI Explorer and installer UI.
const appSizes = [32, 16, 24, 48, 64, 256];
const traySizes = [32, 16, 20, 24, 40, 48, 64];
const temporary = await mkdtemp(join(tmpdir(), "spawn-desktop-icons-"));

async function resized(size, output) {
  await sharp(master)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, palette: false })
    .toFile(output);
}

async function buildIco(sizes, name) {
  const layers = [];
  for (const size of sizes) {
    const layer = join(temporary, `${name}-${size}.png`);
    await resized(size, layer);
    layers.push(layer);
  }
  return pngToIco(layers);
}

async function assertCurrent(path, expected) {
  let actual;
  try {
    actual = await readFile(path);
  } catch {
    throw new Error(`${path} is missing; run npm run icons`);
  }
  if (!actual.equals(expected)) {
    throw new Error(`${path} is stale; run npm run icons`);
  }
}

try {
  const appIco = await buildIco(appSizes, "app");
  const trayIco = await buildIco(traySizes, "tray");
  const outputs = new Map([
    ["icon.ico", appIco],
    ["tray-windows.ico", trayIco],
    ["tray-windows.png", await sharp(master).resize(32, 32).png().toBuffer()],
    ["tray-windows@2x.png", await sharp(master).resize(64, 64).png().toBuffer()],
  ]);
  for (const size of [16, 20, 24, 32, 40, 48, 64]) {
    outputs.set(
      `tray-windows-${size}.png`,
      await sharp(master).resize(size, size).png().toBuffer(),
    );
  }

  for (const [name, bytes] of outputs) {
    const output = join(here, name);
    if (checkOnly) await assertCurrent(output, bytes);
    else await writeFile(output, bytes);
  }

  const metadata = await sharp(master).metadata();
  if (metadata.width !== 1024 || metadata.height !== 1024 || metadata.hasAlpha !== true) {
    throw new Error("icons/icon.png must remain a 1024×1024 RGBA master");
  }
  console.log(
    checkOnly
      ? "Windows desktop icons are current"
      : "Rendered icon.ico and colored Windows tray assets",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
