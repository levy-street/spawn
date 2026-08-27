// Renders icon.html to icon.png (1024) and icon.icns, the bundle's two icon
// forms, from the same trident the app wears everywhere else. Run through
// `npm run icons`; needs the web workspace's Playwright WebKit.
//
// The trident is fitted by its ink, not by its viewBox: the art carries its
// own padding, so the page is rendered once to find where the mark actually
// lands, then the fit is corrected and it is rendered again. `--mark-height`
// and `--mark-drop` in icon.html are the ink box asked for, in canvas pixels.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webkit } from "../../../web/node_modules/playwright-core/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const png = resolve(here, "icon.png");
const icns = resolve(here, "icon.icns");
const CANVAS = 1024;

const browser = await webkit.launch();
const page = await browser.newPage({
  viewport: { width: CANVAS, height: CANVAS },
  deviceScaleFactor: 1,
});
await page.goto(pathToFileURL(resolve(here, "icon.html")).href);
// WebKit fetches an <img> or a CSS mask with CORS, which a file:// page cannot
// pass, so the vendored art is inlined as its own paths (as dmg/render.mjs
// does) and painted with its call site's ink.
const art = await page.$$eval("[data-art]", (nodes) => nodes.map((node) => node.dataset.art));
await page.evaluate(
  (inlined) => {
    for (const [path, svg] of inlined) {
      document.querySelector(`[data-art="${path}"]`).innerHTML = svg;
    }
  },
  // The vendored trident is painted hellfire for the app's own chrome; here it
  // is the ink on a hellfire plate, so every painted fill takes the call
  // site's colour. `fill="none"` is structure — the clip — and stays.
  art.map((path) => [
    path,
    readFileSync(resolve(here, path), "utf8").replace(
      /fill="(?!none)[^"]*"/gu,
      'fill="currentColor"',
    ),
  ]),
);

/** The mark's ink box on the canvas, in pixels. */
const inkBox = async () =>
  await page.evaluate(() => {
    const svg = document.querySelector(".mark svg");
    const ink = svg.getBBox();
    const scale = svg.getBoundingClientRect().height / svg.viewBox.baseVal.height;
    const origin = svg.getBoundingClientRect();
    return {
      height: ink.height * scale,
      centreY: origin.top + (ink.y + ink.height / 2) * scale,
      centreX: origin.left + (ink.x + ink.width / 2) * scale,
    };
  });

// Fit by measurement, not by arithmetic on a viewBox: scale the art until its
// ink is the height asked for, then centre the ink — twice, because resizing
// the art box moves the ink inside it.
const asked = await page.evaluate(() => {
  const style = getComputedStyle(document.documentElement);
  return {
    height: Number.parseFloat(style.getPropertyValue("--mark-height")),
    drop: Number.parseFloat(style.getPropertyValue("--mark-drop")),
  };
});
const place = async (boxHeight, dx, dy) =>
  await page.evaluate(
    ({ boxHeight, dx, dy }) => {
      const mark = document.querySelector(".mark");
      mark.style.height = `${boxHeight}px`;
      mark.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    },
    { boxHeight, dx, dy },
  );

let boxHeight = asked.height;
let dx = 0;
let dy = asked.drop;
for (let pass = 0; pass < 4; pass += 1) {
  const ink = await inkBox();
  boxHeight *= asked.height / ink.height;
  // Where the ink should be, less where it is: the plate's centre, plus the
  // drop that keeps a top-heavy mark from reading high.
  dx += CANVAS / 2 - ink.centreX;
  dy += CANVAS / 2 + asked.drop - ink.centreY;
  await place(boxHeight, dx, dy);
}

await page.locator(".icon").screenshot({ path: png, omitBackground: true });
await browser.close();

// icon.icns: every size macOS asks for, cut from the 1024 with sips.
const iconset = mkdtempSync(resolve(tmpdir(), "spawnd-icon-")) + "/icon.iconset";
execFileSync("mkdir", ["-p", iconset]);
for (const [size, name] of [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
]) {
  const out = resolve(iconset, name);
  writeFileSync(out, readFileSync(png));
  execFileSync("sips", ["-z", String(size), String(size), out], { stdio: "ignore" });
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
rmSync(dirname(iconset), { recursive: true, force: true });
console.log(`wrote ${png} and ${icns}`);
