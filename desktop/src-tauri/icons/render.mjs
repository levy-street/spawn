// One deterministic icon pipeline for both desktop platforms.
//
// icon.html owns the macOS plate and mark geometry. The script reads those CSS
// values, fits the vendored trident by its painted ink rather than its padded
// SVG viewBox, and emits the macOS 1024 px PNG, ICNS, and template tray PNGs.
// That freshly rendered PNG is then the colour master for the Windows app ICO,
// tray ICO, runtime tray PNGs, and their DPI layers.
//
// `--check` compares expected bytes without rewriting them. ICNS is a small
// typed container around PNG layers, so it is packed here rather than delegated
// to Apple's unreliable iconutil; the same command works on macOS and Windows.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pngToIco from "png-to-ico";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes("--check");
const temporary = await mkdtemp(join(tmpdir(), "spawn-desktop-icons-"));
const html = await readFile(join(here, "icon.html"), "utf8");
const sourceSvg = await readFile(join(here, "../../src/assets/spawnd-icon.svg"), "utf8");

const paths = {
  png: join(here, "icon.png"),
  icns: join(here, "icon.icns"),
  tray: join(here, "tray.png"),
  tray2x: join(here, "tray@2x.png"),
};

const appSizes = [32, 16, 24, 48, 64, 256];
const windowsTraySizes = [32, 16, 20, 24, 40, 48, 64];
const icnsTypes = [
  [16, "icp4"],
  [32, "icp5"],
  [64, "icp6"],
  [128, "ic07"],
  [256, "ic08"],
  [512, "ic09"],
  [1024, "ic10"],
  // Retina aliases: 16@2x, 32@2x, 128@2x, and 256@2x.
  [32, "ic11"],
  [64, "ic12"],
  [256, "ic13"],
  [512, "ic14"],
];

function cssPixels(name) {
  const match = html.match(new RegExp(`--${name}:\\s*([0-9.]+)px`));
  if (!match) throw new Error(`icons/icon.html does not define --${name} in pixels`);
  return Number.parseFloat(match[1]);
}

function cssColor(name) {
  const match = html.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`icons/icon.html does not define --${name} as a hex colour`);
  return match[1];
}

function blackMarkSvg() {
  return sourceSvg.replace(/fill="(?!none)[^"]*"/gu, 'fill="#000000"');
}

/** Measure the visible trident within its padded square SVG. */
async function markInkBox(svg) {
  const probeSize = 4096;
  const { data, info } = await sharp(Buffer.from(svg))
    .resize(probeSize, probeSize, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      if (alpha === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error("the SPAWN D trident has no painted ink");
  return { probeSize, left, top, right, bottom };
}

/** Paint the mark so its measured ink has the requested height and centre. */
async function renderMark(canvas, inkHeight, drop, svg, ink) {
  const measuredHeight = ink.bottom - ink.top + 1;
  const fullSize = Math.round((inkHeight * ink.probeSize) / measuredHeight);
  const scale = fullSize / ink.probeSize;
  const inkCenterX = ((ink.left + ink.right + 1) / 2) * scale;
  const inkCenterY = ((ink.top + ink.bottom + 1) / 2) * scale;
  const left = Math.round(canvas / 2 - inkCenterX);
  const top = Math.round(canvas / 2 + drop - inkCenterY);
  const mark = await sharp(Buffer.from(svg))
    .resize(fullSize, fullSize, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  return sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, left, top }])
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

async function renderMacPngs() {
  const canvas = cssPixels("canvas");
  const plate = cssPixels("plate");
  const radius = cssPixels("radius");
  const markHeight = cssPixels("mark-height");
  const markDrop = cssPixels("mark-drop");
  const trayCanvas = cssPixels("tray-canvas");
  const trayHeight = cssPixels("tray-mark-height");
  const hellfire = cssColor("hellfire");
  const svg = blackMarkSvg();
  const ink = await markInkBox(svg);
  const markLayer = await renderMark(canvas, markHeight, markDrop, svg, ink);
  const plateInset = (canvas - plate) / 2;
  const plateLayer = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}">` +
      `<rect x="${plateInset}" y="${plateInset}" width="${plate}" height="${plate}" rx="${radius}" fill="${hellfire}"/>` +
      "</svg>",
  );
  const png = await sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: plateLayer }, { input: markLayer }])
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  const tray = await renderMark(trayCanvas, trayHeight, 0, svg, ink);
  const tray2x = await renderMark(trayCanvas * 2, trayHeight * 2, 0, svg, ink);
  return { png, tray, tray2x };
}

async function buildIcns(master) {
  const pngs = new Map();
  const entries = [];
  for (const [size, type] of icnsTypes) {
    if (!pngs.has(size)) pngs.set(size, await resized(master, size));
    const png = pngs.get(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + header.length, 4);
    entries.push(header, png);
  }
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(body.length + header.length, 4);
  return Buffer.concat([header, body]);
}

async function resized(master, size) {
  return sharp(master)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

async function buildIco(master, sizes, name) {
  const layers = [];
  for (const size of sizes) {
    const layer = join(temporary, `${name}-${size}.png`);
    await writeFile(layer, await resized(master, size));
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
  if (!actual.equals(expected)) throw new Error(`${path} is stale; run npm run icons`);
}

try {
  const mac = await renderMacPngs();
  const master = mac.png;
  const icns = await buildIcns(master);
  const macOutputs = new Map([
    [paths.png, master],
    [paths.icns, icns],
    [paths.tray, mac.tray],
    [paths.tray2x, mac.tray2x],
  ]);
  for (const [path, bytes] of macOutputs) {
    if (checkOnly) await assertCurrent(path, bytes);
    else await writeFile(path, bytes);
  }

  const metadata = await sharp(master).metadata();
  if (metadata.width !== 1024 || metadata.height !== 1024 || metadata.hasAlpha !== true) {
    throw new Error("icons/icon.png must remain a 1024×1024 RGBA master");
  }

  const windowsOutputs = new Map([
    ["icon.ico", await buildIco(master, appSizes, "app")],
    ["tray-windows.ico", await buildIco(master, windowsTraySizes, "tray")],
    ["tray-windows.png", await resized(master, 32)],
    ["tray-windows@2x.png", await resized(master, 64)],
  ]);
  for (const size of [...windowsTraySizes].sort((a, b) => a - b)) {
    windowsOutputs.set(`tray-windows-${size}.png`, await resized(master, size));
  }
  for (const [name, bytes] of windowsOutputs) {
    const path = join(here, name);
    if (checkOnly) await assertCurrent(path, bytes);
    else await writeFile(path, bytes);
  }

  console.log(
    checkOnly
      ? "All macOS and Windows desktop icons are current"
      : "Rendered macOS and Windows desktop icons",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
