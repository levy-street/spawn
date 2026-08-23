import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Dividers must be symmetric.
 *
 * A hairline that clears one edge of the screen but runs into the other reads
 * as a misalignment rather than as a style, and it kept coming back because the
 * offset was written on a single side — often in an inline override sitting
 * next to the StyleSheet entry that draws the line, so neither half looked
 * wrong on its own. This resolves each style composition back into one object
 * and fails on any divider that is pushed off one horizontal edge only.
 */

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** Generated blobs — vendored CSS, not styles this app authors. */
const SKIPPED = new Set(["src/terminal/worker/worker-html.ts"]);

/** A style that paints a line: a hairline-tall view, or a bordered edge. */
const DIVIDER_MARKERS = [/\bheight:\s*borderWidth\./, /\bborderTopWidth:/, /\bborderBottomWidth:/];

/** Each horizontal offset and the counterparts that keep it balanced. */
const COUNTERPARTS: Readonly<Record<string, readonly string[]>> = {
  marginLeft: ["marginRight", "marginHorizontal"],
  marginRight: ["marginLeft", "marginHorizontal"],
  marginStart: ["marginEnd", "marginHorizontal"],
  marginEnd: ["marginStart", "marginHorizontal"],
  paddingLeft: ["paddingRight", "paddingHorizontal"],
  paddingRight: ["paddingLeft", "paddingHorizontal"],
  paddingStart: ["paddingEnd", "paddingHorizontal"],
  paddingEnd: ["paddingStart", "paddingHorizontal"],
  left: ["right"],
  right: ["left"],
};

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Index of the `}`/`]` closing the bracket that opens at `open`. */
function matchBracket(source: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "[": "]" };
  const depth: string[] = [];
  for (let i = open; i < source.length; i += 1) {
    const char = source[i] as string;
    if (char in pairs) depth.push(pairs[char] as string);
    else if (char === "}" || char === "]") {
      if (depth.pop() !== char) return -1;
      if (depth.length === 0) return i;
    }
  }
  return -1;
}

/** A block's own properties, with the braces dropped and nested blocks blanked out. */
function ownProperties(block: string): string {
  let text = block.startsWith("{") && block.endsWith("}") ? block.slice(1, -1) : block;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/\{[^{}]*\}/g, (nested) => " ".repeat(nested.length));
  } while (text !== previous);
  return text;
}

/** Every brace-balanced block in a snippet, outermost first. */
function balancedBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const close = matchBracket(text, i);
    if (close !== -1) blocks.push(text.slice(i, close + 1));
  }
  return blocks;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function declares(text: string, property: string): boolean {
  return new RegExp(`(^|[\\s,{])${property}:`).test(text);
}

/** Named StyleSheet entries in a file, keyed as `sheetName.entryName`. */
function styleSheetEntries(source: string): Map<string, { own: string; line: number }> {
  const entries = new Map<string, { own: string; line: number }>();
  const sheet = /(?:const|let)\s+(\w+)\s*=\s*StyleSheet\.create\(\s*\{/g;
  for (let call = sheet.exec(source); call !== null; call = sheet.exec(source)) {
    const sheetName = call[1] as string;
    const open = source.indexOf("{", call.index + call[0].length - 1);
    const close = matchBracket(source, open);
    if (close === -1) continue;
    const body = source.slice(open + 1, close);
    const entry = /(^|\n)\s*(\w+):\s*\{/g;
    for (let hit = entry.exec(body); hit !== null; hit = entry.exec(body)) {
      const entryOpen = body.indexOf("{", hit.index + hit[0].length - 1);
      const entryClose = matchBracket(body, entryOpen);
      if (entryClose === -1) continue;
      const block = body.slice(entryOpen, entryClose + 1);
      entries.set(`${sheetName}.${hit[2] as string}`, {
        own: ownProperties(block),
        line: lineOf(source, open + 1 + entryOpen),
      });
      entry.lastIndex = entryClose;
    }
    sheet.lastIndex = close;
  }
  return entries;
}

/** Everything a single `style=` attribute composes, flattened into one object. */
function styleCompositions(
  source: string,
  entries: ReadonlyMap<string, { own: string; line: number }>,
): { own: string; line: number }[] {
  const compositions: { own: string; line: number }[] = [];
  const attribute = /\bstyle=\{/g;
  for (let hit = attribute.exec(source); hit !== null; hit = attribute.exec(source)) {
    const open = hit.index + hit[0].length - 1;
    const close = matchBracket(source, open);
    if (close === -1) continue;
    const value = source.slice(open, close + 1);
    attribute.lastIndex = close;

    const parts: string[] = [];
    // Inline overrides: `{ marginLeft: 16 }` written alongside a named entry.
    for (const block of balancedBlocks(value)) parts.push(ownProperties(block));
    // Named entries: `styles.separator`, `paneRowStyles.frame`.
    for (const reference of value.matchAll(/\b(\w+)\.(\w+)\b/g)) {
      const resolved = entries.get(`${reference[1] as string}.${reference[2] as string}`);
      if (resolved !== undefined) parts.push(resolved.own);
    }
    if (parts.length > 0) compositions.push({ own: parts.join("\n"), line: lineOf(source, open) });
  }
  return compositions;
}

describe("divider symmetry", () => {
  const files = sourceFiles(SRC).filter(
    (path) => !SKIPPED.has(relative(ROOT, path).replaceAll("\\", "/")),
  );

  it("scans the whole source tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no divider that is offset from one horizontal edge but not the other", () => {
    const offences: string[] = [];

    for (const path of files) {
      const source = readFileSync(path, "utf8");
      if (!DIVIDER_MARKERS.some((marker) => marker.test(source))) continue;

      const entries = styleSheetEntries(source);
      const candidates = [...entries.values(), ...styleCompositions(source, entries)];

      for (const { own, line } of candidates) {
        if (!DIVIDER_MARKERS.some((marker) => marker.test(own))) continue;
        for (const [offset, balancers] of Object.entries(COUNTERPARTS)) {
          if (!declares(own, offset)) continue;
          if (balancers.some((balancer) => declares(own, balancer))) continue;
          offences.push(
            `${relative(ROOT, path)}:${line} — divider sets ${offset} with no ${balancers.join(" or ")}`,
          );
        }
      }
    }

    expect(offences).toEqual([]);
  });
});
