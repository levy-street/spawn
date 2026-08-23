#!/usr/bin/env node
// Generates every launcher / splash / notification asset the native app ships,
// straight from the one master vector in web/public/brand/spawnd-icon-black.svg.
//
// Requires librsvg (`brew install librsvg`) for `rsvg-convert`, which renders the
// composed SVG at an exact pixel size and — when given `-b <colour>` — writes a
// true RGB PNG with no alpha channel, which is what App Store Connect demands of
// the iOS icon.
//
//   node scripts/generate-brand-assets.mjs [--check]
//
// `--check` regenerates into a temp dir and diffs, so CI can catch assets that
// drifted from the master vector.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
const MASTER = resolve(MOBILE, "../web/public/brand/spawnd-icon-black.svg");
const OUT = resolve(MOBILE, "assets/images");

// ── brand ────────────────────────────────────────────────────────────────────
// Hellfire red and void black, per src/theme/colors.ts (pressroomColors).
const HELLFIRE = "#E11E15";
const VOID = "#000000";
const NEAR_BLACK = "#0B0B0B"; // iOS dark-variant field
const TINT_GLYPH = "#EDEDED"; // grayscale glyph; iOS applies the user's tint

// The master artwork's true bounding box inside its own 538x538 viewBox. The
// glyph is drawn full-bleed vertically (y 0..538) and is *not* centred in the
// viewBox, so every layout below is computed against this box, not the viewBox.
const ART = { x: 32.25, y: 0, w: 457.25, h: 538 };

// The shipped brand lockup, measured off web/public/icon-512.png: the glyph is
// 70.3% of the canvas height, horizontally centred, nudged 2.734% downward.
// Both the web icon and the previous app icon agree on this exactly.
const LOCKUP_H = 0.703;
const LOCKUP_DY = 14 / 512;

// Android adaptive icons are masked to a centred circle. Only the inner 66 of
// the 108dp foreground is guaranteed visible, so the glyph must fit a circle of
// radius 1024 * 66/108 / 2 = 312.9px. Solved numerically (see --verify notes):
// at 51.65% height with the brand offset the glyph's farthest point sits at
// exactly 300px, leaving ~13px of margin. Keeping the downward brand offset
// actually permits a *larger* glyph here (51.65% vs 48.30% dead-centred),
// because the trident is top-heavy and the nudge pulls its prongs inward.
const ADAPTIVE_H = 0.5165;

// Android status-bar icons are a flat white silhouette on 24dp with ~2dp of
// padding; 96px is the xxxhdpi rendering of that.
const NOTIFICATION_H = 0.84;

/** @type {{file:string,size:number,bg:string|null,fg:string,h:number,dy:number,note:string}[]} */
const ASSETS = [
  // iOS + universal fallback. Opaque: no alpha channel anywhere near the App Store.
  { file: "icon.png", size: 1024, bg: HELLFIRE, fg: VOID, h: LOCKUP_H, dy: LOCKUP_DY,
    note: "iOS default + universal fallback — black trident on hellfire" },
  { file: "icon-dark.png", size: 1024, bg: NEAR_BLACK, fg: HELLFIRE, h: LOCKUP_H, dy: LOCKUP_DY,
    note: "iOS 18 dark variant — inverted, hellfire trident on near-black" },
  { file: "icon-tinted.png", size: 1024, bg: VOID, fg: TINT_GLYPH, h: LOCKUP_H, dy: LOCKUP_DY,
    note: "iOS 18 tinted variant — grayscale, system applies the user's tint" },

  // Android adaptive layers. Transparent; the launcher supplies the red field.
  { file: "adaptive-icon.png", size: 1024, bg: null, fg: VOID, h: ADAPTIVE_H, dy: LOCKUP_DY,
    note: "Android adaptive foreground — safe-zone constrained" },
  { file: "adaptive-icon-monochrome.png", size: 1024, bg: null, fg: "#FFFFFF", h: ADAPTIVE_H, dy: LOCKUP_DY,
    note: "Android 13+ themed icon — system tints this silhouette" },

  // Android status bar. Must be a white-on-transparent silhouette or Android
  // renders the notification icon as a solid white blob.
  { file: "notification-icon.png", size: 96, bg: null, fg: "#FFFFFF", h: NOTIFICATION_H, dy: 0,
    note: "Android notification small icon — white silhouette" },

  // Splash. One glyph for both themes; app.json supplies the per-theme field
  // colour so the splash background matches the app's first painted frame.
  { file: "splash-icon.png", size: 1024, bg: null, fg: HELLFIRE, h: LOCKUP_H, dy: LOCKUP_DY,
    note: "Splash mark — hellfire trident, theme-matched field via app.json" },
];

function sigilPath() {
  const svg = readFileSync(MASTER, "utf8");
  const m = svg.match(/<path d="([^"]+)"/);
  if (!m) throw new Error(`no <path> found in master vector: ${MASTER}`);
  return m[1];
}

/** Compose a standalone SVG that places the glyph at the requested size/offset. */
function compose(d, { size, bg, fg, h, dy }) {
  const drawnH = size * h;
  const k = drawnH / ART.h;
  const cx = size / 2;
  const cy = size / 2 + size * dy;
  const tx = cx - (ART.w * k) / 2;
  const ty = cy - (ART.h * k) / 2;
  const field = bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
${field}
<g transform="translate(${tx.toFixed(4)},${ty.toFixed(4)}) scale(${k.toFixed(8)}) translate(${-ART.x},${-ART.y})">
<path d="${d}" fill="${fg}"/>
</g>
</svg>`;
}

function render(d, asset, outDir, scratch) {
  const svgPath = join(scratch, `${asset.file}.svg`);
  writeFileSync(svgPath, compose(d, asset));
  const args = ["-w", String(asset.size), "-h", String(asset.size)];
  // `-b` bakes an opaque field and drops the alpha channel entirely; without it
  // rsvg-convert emits RGBA, which is right for the transparent layers.
  if (asset.bg) args.push("-b", asset.bg);
  else args.push("-b", "none");
  args.push(svgPath, "-o", join(outDir, asset.file));
  execFileSync("rsvg-convert", args, { stdio: ["ignore", "ignore", "pipe"] });
}

function main() {
  const check = process.argv.includes("--check");
  try {
    execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("rsvg-convert not found. Install it with:  brew install librsvg");
    process.exit(1);
  }

  const d = sigilPath();
  const scratch = mkdtempSync(join(tmpdir(), "spawn-brand-"));
  const outDir = check ? mkdtempSync(join(tmpdir(), "spawn-brand-out-")) : OUT;
  mkdirSync(outDir, { recursive: true });

  for (const asset of ASSETS) {
    render(d, asset, outDir, scratch);
    console.log(`  ${asset.file.padEnd(30)} ${String(asset.size).padStart(4)}px  ${asset.note}`);
  }

  if (check) {
    let drifted = 0;
    for (const asset of ASSETS) {
      const a = readFileSync(join(outDir, asset.file));
      let b;
      try {
        b = readFileSync(join(OUT, asset.file));
      } catch {
        console.error(`MISSING: ${asset.file}`);
        drifted++;
        continue;
      }
      if (!a.equals(b)) {
        console.error(`DRIFTED: ${asset.file} differs from the master vector`);
        drifted++;
      }
    }
    if (drifted) {
      console.error(`\n${drifted} asset(s) out of date — run: npm run brand:assets`);
      process.exit(1);
    }
    console.log("\nAll brand assets match the master vector.");
    return;
  }

  console.log(`\nWrote ${ASSETS.length} assets to ${OUT}`);
  const stray = readdirSync(OUT).filter(
    (f) => f.endsWith(".png") && !ASSETS.some((a) => a.file === f) && f !== "altar-ink.png",
  );
  if (stray.length) console.log(`Note: unmanaged PNGs still present: ${stray.join(", ")}`);
}

main();
