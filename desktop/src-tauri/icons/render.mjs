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
// Exactly the members `iconutil` writes, and no others. The 16 and 32 px
// slots are `ic04` / `ic05` in Apple's ARGB run-length form: IconServices reads
// a PNG in those two slots as raw pixels, so the `icp4` / `icp5` PNG members
// this once emitted drew as coloured noise everywhere macOS shows an icon at
// 16 px — Login Items, the Dock's menu, Force Quit — while AppKit, which skips
// them, drew the mark. `iconutil -c iconset` on such a file reproduces the
// noise. There is no 64 px member: 32@2x (`ic12`) is what macOS reads there.
const icnsTypes = [
  [16, "ic04", "argb"],
  [32, "ic05", "argb"],
  [128, "ic07", "png"],
  [256, "ic08", "png"],
  [512, "ic09", "png"],
  [1024, "ic10", "png"],
  // Retina aliases: 16@2x, 32@2x, 128@2x, and 256@2x.
  [32, "ic11", "png"],
  [64, "ic12", "png"],
  [256, "ic13", "png"],
  [512, "ic14", "png"],
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

/**
 * Apple's `ic04` / `ic05` payload: the literal `ARGB`, then four planes — every
 * pixel's alpha, then every red, green and blue, straight (never premultiplied)
 * bytes — run-length packed the way the classic `is32` members were: a byte
 * under 0x80 copies the next n+1 bytes, a byte of 0x80 or more repeats the
 * next byte n−125 times. Decoded from what `iconutil` writes for the same PNG
 * and matched plane for plane.
 */
function packArgb(rgba, width, height) {
  const pixels = width * height;
  const planes = Buffer.alloc(pixels * 4);
  for (let index = 0; index < pixels; index += 1) {
    planes[index] = rgba[index * 4 + 3];
    planes[pixels + index] = rgba[index * 4];
    planes[pixels * 2 + index] = rgba[index * 4 + 1];
    planes[pixels * 3 + index] = rgba[index * 4 + 2];
  }
  return Buffer.concat([Buffer.from("ARGB", "ascii"), packBits(planes)]);
}

function packBits(bytes) {
  const out = [];
  const runAt = (at) =>
    at + 2 < bytes.length && bytes[at] === bytes[at + 1] && bytes[at] === bytes[at + 2];
  let index = 0;
  while (index < bytes.length) {
    if (runAt(index)) {
      let run = 3;
      while (run < 130 && index + run < bytes.length && bytes[index + run] === bytes[index]) {
        run += 1;
      }
      out.push(0x80 + (run - 3), bytes[index]);
      index += run;
      continue;
    }
    let literal = 1;
    while (literal < 128 && index + literal < bytes.length && !runAt(index + literal)) {
      literal += 1;
    }
    out.push(literal - 1, ...bytes.subarray(index, index + literal));
    index += literal;
  }
  return Buffer.from(out);
}

async function argbMember(master, size) {
  const { data, info } = await sharp(master)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return packArgb(data, info.width, info.height);
}

async function buildIcns(master) {
  const members = new Map();
  const entries = [];
  for (const [size, type, form] of icnsTypes) {
    const key = `${form}:${size}`;
    if (!members.has(key)) {
      members.set(
        key,
        form === "argb" ? await argbMember(master, size) : await resized(master, size),
      );
    }
    const payload = members.get(key);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(payload.length + header.length, 4);
    entries.push(header, payload);
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
