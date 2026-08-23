/**
 * Finding a folder's own icon.
 *
 * Every workspace in the sidebar wore the same two-letter monogram, so the
 * list read as one shape repeated. A project almost always ships something
 * better — a favicon, an app icon, a logo — and the host control channel can
 * already list directories and read files, so the browser can go and find it.
 *
 * This module is the decision half: which directories are worth listing, and
 * which of the files in them is most likely to *be* the project's mark. It is
 * deliberately free of DOM and of the control channel, so the judgement can be
 * tested on plain names. `workspace-icon-image.ts` renders the winner and
 * `workspace-icon-scan.ts` does the walking.
 */

/** The rendered icon's edge, in device pixels. The largest tile it has to
 *  fill is the collapsed rail's `size-9` (36 CSS px), so this covers 3x. */
export const WORKSPACE_ICON_PIXELS = 128;

/** Mirrors `schemas.WORKSPACE_ICON_MAX_CHARS`: past this the server refuses
 *  the write, so the encoder gives up quality rather than the round trip. */
export const WORKSPACE_ICON_MAX_CHARS = 32 * 1024;

/** Refuse to pull a file this large across the channel to look at it. No icon
 *  is 4 MB; something that big is a photograph or a design source file. */
export const WORKSPACE_ICON_MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/**
 * Directory names a project keeps its mark in, or keeps the directory that
 * keeps it. The scan starts at the workspace folder and descends only into
 * children named here.
 *
 * Two kinds of name are in this set, and the split matters. Some are
 * destinations — `assets`, `icons`, `.github` — where the file itself is
 * likely to be. The rest are only steps: `web`, `packages`, `src` hold no
 * marks of their own, but a monorepo's favicon lives at `web/public/` and its
 * logo at `web/public/brand/`, which nothing shallower would ever see. That
 * is what sets the depth at three; the directory budget is what keeps three
 * levels from becoming a crawl.
 */
export const WORKSPACE_ICON_DIR_NAMES: ReadonlySet<string> = new Set([
  // Destinations.
  "public",
  "assets",
  "static",
  "resources",
  ".github",
  "images",
  "img",
  "icons",
  "media",
  "brand",
  "docs",
  // Steps: where a project's app, and therefore its assets, tend to sit.
  "src",
  "app",
  "apps",
  "web",
  "www",
  "site",
  "client",
  "frontend",
  "ui",
  "packages",
  "desktop",
  "electron",
]);

/**
 * The other shape of step: a project directory named after the project, with
 * what it is stuck on the end. A folder holding `painpal-app` and `painpal-api`
 * has no mark of its own, and the app's is one directory inside — but the name
 * that gets there cannot be listed in advance, only recognised.
 */
const PROJECT_DIR_SUFFIX = /[-_](?:app|web|ui|site|client|frontend|desktop|www)$/u;

/** Whether the scan will step into a child directory of this name. */
export function isIconDirName(name: string): boolean {
  return WORKSPACE_ICON_DIR_NAMES.has(name) || PROJECT_DIR_SUFFIX.test(name);
}

/** How deep the descent goes below the workspace folder. */
export const WORKSPACE_ICON_MAX_DEPTH = 3;

/** A ceiling on directories listed per scan, so a repo that happens to have
 *  all of them does not turn one workspace open into fifty round trips. The
 *  walk is breadth-first, so what a full budget drops is the deepest and
 *  least likely directories. */
export const WORKSPACE_ICON_MAX_DIRS = 16;

/** How many pages of a single directory the scan will drain. The daemon
 *  serves 96 entries a page in raw readdir order, so three pages is a fair
 *  look at any folder that plausibly holds an icon. */
export const WORKSPACE_ICON_DIR_PAGES = 3;

/** What the browser can decode in an `<img>` and we are willing to rasterize.
 *  SVG is included: it is rendered to a bitmap here and never stored as
 *  markup. */
const EXTENSION_SCORES: Record<string, number> = {
  svg: 6,
  png: 5,
  webp: 5,
  ico: 3,
  jpg: 2,
  jpeg: 2,
  avif: 1,
};

/** A file's stem, exactly: `favicon` is the mark, `favicon-og` is not. */
const EXACT_STEM_SCORES: Record<string, number> = {
  favicon: 100,
  icon: 95,
  "app-icon": 95,
  appicon: 95,
  logo: 90,
  logomark: 90,
  "logo-mark": 90,
  brandmark: 88,
  mark: 80,
  "apple-touch-icon": 85,
  "icon-512": 84,
  "icon-192": 82,
  avatar: 70,
  ic_launcher: 88,
};

/** Weaker evidence: the stem only mentions being an icon. */
const STEM_HINTS: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^favicon[-_.]/u, score: 78 },
  { pattern: /^(?:app[-_]?)?icon[-_]/u, score: 70 },
  { pattern: /^logo[-_]/u, score: 68 },
  { pattern: /[-_]logo$/u, score: 66 },
  { pattern: /[-_]icon$/u, score: 64 },
  { pattern: /(?:^|[-_])brand(?:$|[-_])/u, score: 55 },
  // Last: the word is in there somewhere. `spawnd-icon-black` is a mark even
  // though it is neither prefixed nor suffixed by the word that says so.
  { pattern: /icon|logo|favicon/u, score: 40 },
];

/**
 * Names that are images of the project rather than marks for it. A repo's
 * `assets/` is mostly screenshots, and one of those in the sidebar is worse
 * than the monogram it replaced — so these are refused outright rather than
 * merely ranked low.
 */
const NOT_A_MARK =
  /screenshot|screen[-_]?shot|banner|hero|cover|header|footer|og[-_]?image|opengraph|social|preview|demo|diagram|architecture|chart|graph|background|wallpaper|placeholder|thumbnail|sprite|photo|team|slide/u;

/** The floor a generic image in an asset directory starts from, so a folder
 *  with `assets/duck.png` and nothing else still gets a mark. */
const UNNAMED_IMAGE_SCORE = 12;

/** Read off the directory's last segment, so `src/assets` is scored as the
 *  assets directory it is, one step further away. */
const DIR_SCORES: Record<string, number> = {
  "": 30,
  public: 26,
  icons: 24,
  assets: 22,
  static: 22,
  brand: 22,
  resources: 20,
  ".github": 20,
  media: 16,
  images: 14,
  img: 14,
  app: 12,
  src: 8,
  docs: 6,
};

/** Each step down from the workspace folder is a step further from being the
 *  thing the folder is called. */
const DIR_DEPTH_PENALTY = 2;

export type IconCandidate = {
  /** Absolute path on the host, ready for `fs.read`. */
  path: string;
  /** File name, shown under the suggestion in the picker. */
  name: string;
  /** Directory relative to the workspace folder; "" is the folder itself. */
  dir: string;
  size: number | null;
  score: number;
};

function splitName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name.toLowerCase(), extension: "" };
  return { stem: name.slice(0, dot).toLowerCase(), extension: name.slice(dot + 1).toLowerCase() };
}

/**
 * How much this file looks like the folder's mark, or null if it is not one.
 *
 * The name dominates, the directory breaks ties between equally-named files,
 * and size is the last word: between two `logo.png`s the bigger one has the
 * resolution to survive being drawn at 36px, and a 16px `favicon.ico` should
 * lose to a real app icon that happens to sit one directory deeper.
 */
export function scoreIconCandidate(
  dir: string,
  name: string,
  size: number | null = null,
): number | null {
  if (name.startsWith(".")) return null;
  const { stem, extension } = splitName(name);
  const extensionScore = EXTENSION_SCORES[extension];
  if (extensionScore === undefined) return null;
  if (size !== null && size > WORKSPACE_ICON_MAX_SOURCE_BYTES) return null;

  const named =
    EXACT_STEM_SCORES[stem] ?? STEM_HINTS.find(({ pattern }) => pattern.test(stem))?.score ?? null;
  // A screenshot called `screenshot.png` is never the mark. One called
  // `logo-screenshot.png` is not either — the disqualifier outranks the hint.
  if (NOT_A_MARK.test(stem)) return null;
  const nameScore = named ?? UNNAMED_IMAGE_SCORE;
  const segments = dir === "" ? [] : dir.split("/");
  const dirScore = Math.max(
    0,
    (DIR_SCORES[segments.at(-1) ?? ""] ?? 0) - segments.length * DIR_DEPTH_PENALTY,
  );
  // An unnamed image is only ever a fallback: it may not outrank a named one
  // by sitting in a better directory, so its directory bonus is dropped.
  const placement = named === null ? 0 : dirScore;
  const bulk = size === null ? 0 : Math.min(size / 4096, 8);
  return nameScore * 1000 + placement * 10 + extensionScore + bulk;
}

/**
 * The candidates from one directory listing, best first.
 *
 * `dir` is the listing's path relative to the workspace folder, which is what
 * the scoring reads; entries keep their absolute `path` for the read that
 * follows.
 */
export function rankIconCandidates(
  dir: string,
  entries: ReadonlyArray<{ name: string; path: string; is_dir: boolean; size?: number | null }>,
): IconCandidate[] {
  return entries
    .filter((entry) => !entry.is_dir)
    .map((entry) => {
      const size = entry.size ?? null;
      const score = scoreIconCandidate(dir, entry.name, size);
      return score === null ? null : { path: entry.path, name: entry.name, dir, size, score };
    })
    .filter((candidate): candidate is IconCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * Every directory's candidates merged into one ranked list, with duplicates
 * (the same file reached through two listed directories) collapsed.
 */
export function mergeIconCandidates(groups: ReadonlyArray<IconCandidate[]>): IconCandidate[] {
  const byPath = new Map<string, IconCandidate>();
  for (const candidate of groups.flat()) {
    const existing = byPath.get(candidate.path);
    if (!existing || candidate.score > existing.score) byPath.set(candidate.path, candidate);
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * An image of `width` x `height` drawn as large as it goes inside a `box`
 * square without cropping or distortion, centred, rounded to whole pixels.
 *
 * Contain rather than cover: a mark is usually wider than it is tall (a
 * wordmark) or a small glyph in a large transparent field (a favicon), and
 * cropping either one to fill a square cuts the thing you were trying to
 * recognise. An image with no intrinsic size — an SVG that declares only a
 * viewBox — is given the whole square, which is what it asks for.
 */
export function fitContain(
  width: number,
  height: number,
  box: number,
): { width: number; height: number; x: number; y: number } {
  if (!(width > 0) || !(height > 0)) return { width: box, height: box, x: 0, y: 0 };
  const scale = Math.min(box / width, box / height);
  const drawn = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
  return {
    ...drawn,
    x: Math.round((box - drawn.width) / 2),
    y: Math.round((box - drawn.height) / 2),
  };
}

/** The rule the server enforces, applied before the round trip so a bad
 *  render is caught where it happened rather than as a 422. */
export function isWorkspaceIcon(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length <= WORKSPACE_ICON_MAX_CHARS &&
    /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)
  );
}
