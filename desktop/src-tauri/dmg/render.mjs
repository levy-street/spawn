// Renders background.html to background.png at 2× with a 144 dpi tag, the
// form the Finder draws at the window's logical 660×400. Run through
// `npm run dmg:background`; needs the web workspace's Playwright WebKit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webkit } from "../../../web/node_modules/playwright-core/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "background.png");
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 660, height: 400 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(resolve(here, "background.html")).href);
// Vendored art marked data-art is inlined as its own paths: WebKit fetches a
// CSS mask with CORS, which a file:// page cannot pass, so the unpainted
// wordmark goes into the sheet directly, painted with its call site's ink.
const art = await page.$$eval("[data-art]", (nodes) => nodes.map((node) => node.dataset.art));
await page.evaluate(
  (inlined) => {
    for (const [path, svg] of inlined) document.querySelector(`[data-art="${path}"]`).innerHTML = svg;
  },
  art.map((path) => [path, readFileSync(resolve(here, path), "utf8").replaceAll('fill="white"', 'fill="currentColor"')]),
);
await page.waitForTimeout(500);
await page.locator(".bg").screenshot({ path: out, omitBackground: false });
await browser.close();
execFileSync("sips", ["-s", "dpiWidth", "144", "-s", "dpiHeight", "144", out], { stdio: "ignore" });
console.log(`wrote ${out}`);
