#!/usr/bin/env node
/*
 * OG images for landing pages: a screenshot of each page's own hero
 * (grimoire §viii, the OG image is the page's own hero). Hides the sticky masthead, forces the hero to
 * the 1200×630 frame, and captures at 2× into
 * public/og/<slug>.jpg — the size the [slug] router's metadata declares.
 *
 *   node scripts/og-shots.mjs [--base http://localhost:3000] slug [slug…]
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const args = process.argv.slice(2);
let base = "http://localhost:3000";
const slugs = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--base") {
    base = args[i + 1];
    i += 1;
  } else {
    slugs.push(args[i]);
  }
}
if (slugs.length === 0) {
  console.error("usage: og-shots.mjs [--base url] slug [slug…]");
  process.exit(1);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "../public/og");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
  reducedMotion: "no-preference",
});
const page = await ctx.newPage();
for (const slug of slugs) {
  const url = `${base}/${slug}`;
  await page.goto(url, { waitUntil: "load", timeout: 120000 });
  await page.addStyleTag({
    content:
      "header.sticky,nextjs-portal{display:none!important} #hero{display:flex!important;align-items:center!important;min-height:630px!important;height:630px!important;padding-top:0!important;padding-bottom:0!important}",
  });
  await page.waitForTimeout(600);
  const out = join(outDir, `${slug}.jpg`);
  await page.screenshot({
    path: out,
    type: "jpeg",
    quality: 82,
    clip: { x: 0, y: 0, width: 1200, height: 630 },
  });
  console.log(`${slug} → ${out}`);
}
await browser.close();
