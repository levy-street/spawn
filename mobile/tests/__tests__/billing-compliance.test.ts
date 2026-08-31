import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The mobile apps never sell anything.
 *
 * No price, no buy button, no link to a purchase page, no clipboard copy or QR
 * code carrying a checkout URL. The apps show subscription *status*, and at the
 * limit they say what the limit is and what can be done inside the app.
 *
 * This is more conservative than App Store guideline 3.1.1(a) currently
 * requires, and deliberately so: that permission is US-storefront-only, the
 * storefront is not the device locale and reading it needs a native StoreKit
 * call this app has no module for, and the permission itself is unstable. So
 * the switch is server-side — `billing.mobile_upgrade_link` is false at launch —
 * and flipping it back off has to work the same day, because a binary already
 * in the store cannot be recalled. See docs/BILLING.md §6.1.
 *
 * The two halves of the bright line, asserted mechanically:
 *
 * 1. no string under `src/` contains a price;
 * 2. no `Linking.openURL` / `expo-web-browser` call sits in a billing surface.
 *
 * A failure here is not a lint nit. It is the app doing something a store
 * reviewer rejects binaries for, in a build that cannot be recalled once it
 * ships.
 */

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** `$5`, `$ 5`, `5 USD`, `500 cents`, `usd 5`. */
const PRICE_PATTERNS = [
  /[$£€]\s?\d/,
  /\b\d+(\.\d+)?\s*(usd|eur|gbp)\b/i,
  /\busd\s*\d/i,
  /\bprice_cents\b/,
  /\bper month\b/i,
  /\/mo\b/,
];

/** Every file that is part of a billing surface, and so may not open a URL. */
const BILLING_SURFACES = [
  "src/data/selectors/billing.ts",
  "src/components/settings/subscription-panel.tsx",
  "src/components/hosts/over-limit-reconciliation.tsx",
  "src/app/(drawer)/(tabs)/settings/subscription.tsx",
];

/** Anything that sends a person out of the app. */
const OUTBOUND_CALLS = [
  /Linking\.openURL/,
  /openBrowserAsync/,
  /expo-web-browser/,
  /WebBrowser\./,
  /Clipboard\.setStringAsync/,
  /presentShareSheet/,
];

/** Vendored blobs — xterm's own CSS, not copy this app authors. */
const SKIPPED = new Set(["src/terminal/worker/worker-html.ts"]);

/**
 * Everything the app ships. Tests are excluded because nothing imports them, so
 * nothing in them reaches a bundle — and a test proving the app *refuses* a
 * server string containing a price has to be able to write one down.
 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (SKIPPED.has(relative(ROOT, path))) continue;
    found.push(path);
  }
  return found;
}

/** The text of every string and template literal in a file, comments excluded. */
function literals(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  const found: string[] = [];
  for (const match of withoutComments.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\]*)`/g)) {
    found.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return found;
}

describe("mobile sells nothing", () => {
  const files = sourceFiles(SRC);

  test("no string anywhere under src contains a price", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const value of literals(readFileSync(file, "utf8"))) {
        if (PRICE_PATTERNS.some((pattern) => pattern.test(value))) {
          offenders.push(`${relative(ROOT, file)}: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no billing surface sends anyone out of the app", () => {
    const offenders: string[] = [];
    for (const surface of BILLING_SURFACES) {
      const source = readFileSync(join(ROOT, surface), "utf8");
      for (const call of OUTBOUND_CALLS) {
        if (call.test(source)) offenders.push(`${surface}: ${String(call)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the app carries no checkout, pricing or upgrade URL", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const value of literals(readFileSync(file, "utf8"))) {
        if (/\/(pricing|checkout|upgrade|billing\/portal|subscribe)\b/.test(value)) {
          offenders.push(`${relative(ROOT, file)}: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no tappable link into the marketing site's download page", () => {
    // `spawnd.dev/download` is where the site's own chrome reaches pricing, so
    // an in-app link to it reads as steering the moment the site sells
    // anything. The install commands it led to are in the About screen already.
    const offenders: string[] = [];
    for (const file of files) {
      for (const value of literals(readFileSync(file, "utf8"))) {
        if (/spawnd\.dev\/download/.test(value)) offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
