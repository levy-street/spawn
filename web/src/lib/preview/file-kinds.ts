/**
 * What a file *is*, for preview purposes.
 *
 * The daemon deliberately tells the file tree almost nothing about type:
 * `fs.list` returns only `kind: file|directory|symlink|other` because adding a
 * `content_type` to every entry would push a 96-entry page past the 16 KiB
 * frame budget and halve the effective page size. So the client classifies from
 * the name, which is free and good enough to pick an icon, a renderer, and a
 * byte budget. The daemon still has the last word on anything it acts on — the
 * `open_allowed` it returns is sniffed from real bytes and is never overridden
 * by what this module guesses.
 *
 * Pure and DOM-free so `bun test` can load it directly.
 */

import type { HostDirEntry } from "@/lib/hostControl";

export type PreviewKind =
  | "image"
  | "svg"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "code"
  | "markdown"
  /** No browser renderer; ask the host to render it to an image. */
  | "quicklook"
  /** Nothing to show but metadata. */
  | "none";

export type FileIconId =
  | "file"
  | "code"
  | "text"
  | "markdown"
  | "image"
  | "vector"
  | "video"
  | "audio"
  | "pdf"
  | "doc"
  | "sheet"
  | "slides"
  | "archive"
  | "binary"
  | "key"
  | "config"
  | "terminal"
  | "database"
  | "font"
  | "symlink";

export type CodeLanguage =
  | "c-like"
  | "js"
  | "ts"
  | "jsx"
  | "python"
  | "shell"
  | "rust"
  | "go"
  | "css"
  | "json"
  | "yaml"
  | "toml"
  | "sql"
  | "xml"
  | "markdown"
  | "plain";

export type FileTypeInfo = {
  kind: PreviewKind;
  /** Human label: "PNG image", "TypeScript source", "Word document". */
  label: string;
  /** Stamped onto the Blob so the browser can decode it. */
  mime: string;
  icon: FileIconId;
  /** Only meaningful when `kind === "code"` or `"markdown"`. */
  language?: CodeLanguage;
  /** Fetched without asking at or below this many bytes. */
  autoBytes: number;
  /** Above this, no inline preview at all — download or open on the host. */
  maxBytes: number;
  /**
   * Looks executable from its name alone. The daemon refuses to `open` these
   * regardless; this flag only lets the UI avoid offering the action.
   */
  executable?: boolean;
};

/**
 * Byte budgets.
 *
 * The transport ceiling is ~64 KiB per round trip (an 8-chunk unacked window of
 * 8 KiB frames), so on a 60 ms WAN link this is roughly 1 MB/s: 4 MiB is about
 * four seconds behind a progress bar, which is the most we should spend without
 * being asked. `inlineMax` stays under `downloadFile`'s existing 32 MiB memory
 * line. Anything larger is the host's job to open.
 */
export const PREVIEW_BUDGET = {
  /** Head slice for a hover text/code peek. */
  hoverText: 96 * 1024,
  /** Largest image we will pull just because the pointer paused on a row. */
  hoverImage: 4 * 1024 * 1024,
  autoFetch: 4 * 1024 * 1024,
  inlineMax: 24 * 1024 * 1024,
  /** Refuse to decode more text than this, however big the file is. */
  textDecode: 1024 * 1024,
  /**
   * Host render sizes. These must be values the daemon allowlists — it accepts
   * {128, 256, 512, 1024} and refuses anything else outright, rather than
   * clamping, so a free number here would simply fail every request.
   */
  thumbPx: { hover: 256, modal: 1024 },
} as const;

const MEDIA_MAX = 512 * 1024 * 1024;

type Entry = {
  kind: PreviewKind;
  label: string;
  mime: string;
  icon: FileIconId;
  language?: CodeLanguage;
  autoBytes?: number;
  maxBytes?: number;
  executable?: boolean;
};

function code(label: string, language: CodeLanguage, icon: FileIconId = "code"): Entry {
  return { kind: "code", label, mime: "text/plain", icon, language };
}

function image(label: string, mime: string): Entry {
  return { kind: "image", label, mime, icon: "image" };
}

function video(label: string, mime: string): Entry {
  return { kind: "video", label, mime, icon: "video", maxBytes: MEDIA_MAX };
}

function audio(label: string, mime: string): Entry {
  return { kind: "audio", label, mime, icon: "audio", maxBytes: MEDIA_MAX };
}

/** Rendered by the host, or shown as a metadata card when it cannot. */
function ql(label: string, icon: FileIconId, mime = "application/octet-stream"): Entry {
  return { kind: "quicklook", label, mime, icon };
}

function opaque(label: string, icon: FileIconId, executable = false): Entry {
  return {
    kind: "none",
    label,
    mime: "application/octet-stream",
    icon,
    ...(executable ? { executable: true } : {}),
  };
}

/** Files whose whole name is the signal — no extension to read. */
const WHOLE_NAME: Record<string, Entry> = {
  dockerfile: code("Dockerfile", "shell", "terminal"),
  containerfile: code("Containerfile", "shell", "terminal"),
  makefile: code("Makefile", "shell", "terminal"),
  justfile: code("Justfile", "shell", "terminal"),
  rakefile: code("Rakefile", "shell", "terminal"),
  gemfile: code("Gemfile", "shell", "terminal"),
  procfile: code("Procfile", "shell", "terminal"),
  "cmakelists.txt": code("CMake script", "shell", "terminal"),
  license: { kind: "text", label: "License", mime: "text/plain", icon: "text" },
  notice: { kind: "text", label: "Notice", mime: "text/plain", icon: "text" },
  readme: { kind: "text", label: "Readme", mime: "text/plain", icon: "text" },
  authors: { kind: "text", label: "Authors", mime: "text/plain", icon: "text" },
  ".gitignore": code("Git ignore rules", "shell", "config"),
  ".gitattributes": code("Git attributes", "shell", "config"),
  ".dockerignore": code("Docker ignore rules", "shell", "config"),
  ".editorconfig": code("EditorConfig", "toml", "config"),
  ".npmrc": code("npm config", "toml", "config"),
  ".nvmrc": code("Node version", "plain", "config"),
  ".prettierrc": code("Prettier config", "json", "config"),
  ".babelrc": code("Babel config", "json", "config"),
  ".bashrc": code("Bash startup file", "shell", "terminal"),
  ".zshrc": code("Zsh startup file", "shell", "terminal"),
  ".profile": code("Shell profile", "shell", "terminal"),
  ".ds_store": opaque("Finder metadata", "binary"),
  ".localized": opaque("Localization marker", "binary"),
};

/** Checked before the single-extension table, longest first. */
const COMPOUND: Array<[string, Entry]> = [
  [".d.ts", code("TypeScript declarations", "ts")],
  [".min.js", code("Minified JavaScript", "js")],
  [".min.css", code("Minified stylesheet", "css")],
  [".tar.gz", opaque("Gzipped tar archive", "archive")],
  [".tar.bz2", opaque("Bzip2 tar archive", "archive")],
  [".tar.xz", opaque("XZ tar archive", "archive")],
  [".tar.zst", opaque("Zstd tar archive", "archive")],
];

const BY_EXTENSION: Record<string, Entry> = {
  // ── Raster images ─────────────────────────────────────────────────────────
  png: image("PNG image", "image/png"),
  jpg: image("JPEG image", "image/jpeg"),
  jpeg: image("JPEG image", "image/jpeg"),
  gif: image("GIF image", "image/gif"),
  webp: image("WebP image", "image/webp"),
  bmp: image("Bitmap image", "image/bmp"),
  ico: image("Icon", "image/x-icon"),
  avif: image("AVIF image", "image/avif"),
  apng: image("Animated PNG", "image/apng"),
  // Safari decodes HEIC; every other browser does not. QuickLook is the
  // reliable path, and on a Mac host it is always available.
  heic: ql("HEIC image", "image", "image/heic"),
  heif: ql("HEIF image", "image", "image/heif"),
  tif: ql("TIFF image", "image", "image/tiff"),
  tiff: ql("TIFF image", "image", "image/tiff"),

  // ── Vector ────────────────────────────────────────────────────────────────
  // Rendered through <img>, never inlined — see `classifyFile`.
  svg: { kind: "svg", label: "SVG image", mime: "image/svg+xml", icon: "vector" },
  ai: ql("Illustrator artwork", "vector"),
  eps: ql("EPS artwork", "vector"),
  sketch: ql("Sketch document", "vector"),
  fig: ql("Figma document", "vector"),
  psd: ql("Photoshop document", "image"),
  afdesign: ql("Affinity Designer document", "vector"),
  afphoto: ql("Affinity Photo document", "image"),

  // ── Documents ─────────────────────────────────────────────────────────────
  pdf: {
    kind: "pdf",
    label: "PDF document",
    mime: "application/pdf",
    icon: "pdf",
    maxBytes: 128 * 1024 * 1024,
  },
  doc: ql("Word document", "doc"),
  docx: ql("Word document", "doc"),
  rtf: ql("Rich text document", "doc"),
  odt: ql("OpenDocument text", "doc"),
  pages: ql("Pages document", "doc"),
  xls: ql("Excel spreadsheet", "sheet"),
  xlsx: ql("Excel spreadsheet", "sheet"),
  ods: ql("OpenDocument spreadsheet", "sheet"),
  numbers: ql("Numbers spreadsheet", "sheet"),
  ppt: ql("PowerPoint presentation", "slides"),
  pptx: ql("PowerPoint presentation", "slides"),
  odp: ql("OpenDocument presentation", "slides"),
  key: ql("Keynote presentation", "slides"),
  epub: ql("EPUB book", "doc"),

  // ── Video ─────────────────────────────────────────────────────────────────
  mp4: video("MPEG-4 video", "video/mp4"),
  m4v: video("MPEG-4 video", "video/mp4"),
  mov: video("QuickTime movie", "video/quicktime"),
  webm: video("WebM video", "video/webm"),
  ogv: video("Ogg video", "video/ogg"),
  mkv: video("Matroska video", "video/x-matroska"),
  avi: video("AVI video", "video/x-msvideo"),
  wmv: video("Windows Media video", "video/x-ms-wmv"),
  flv: video("Flash video", "video/x-flv"),

  // ── Audio ─────────────────────────────────────────────────────────────────
  mp3: audio("MP3 audio", "audio/mpeg"),
  m4a: audio("MPEG-4 audio", "audio/mp4"),
  aac: audio("AAC audio", "audio/aac"),
  wav: audio("WAV audio", "audio/wav"),
  flac: audio("FLAC audio", "audio/flac"),
  ogg: audio("Ogg audio", "audio/ogg"),
  oga: audio("Ogg audio", "audio/ogg"),
  opus: audio("Opus audio", "audio/ogg"),
  aiff: audio("AIFF audio", "audio/aiff"),
  aif: audio("AIFF audio", "audio/aiff"),

  // ── Markup and prose ──────────────────────────────────────────────────────
  md: { kind: "markdown", label: "Markdown", mime: "text/markdown", icon: "markdown" },
  markdown: { kind: "markdown", label: "Markdown", mime: "text/markdown", icon: "markdown" },
  mdx: { kind: "markdown", label: "MDX", mime: "text/markdown", icon: "markdown" },
  txt: { kind: "text", label: "Plain text", mime: "text/plain", icon: "text" },
  log: { kind: "text", label: "Log file", mime: "text/plain", icon: "text" },
  // One JSON object per line — agent transcripts, event logs. Read as text
  // rather than highlighted: a single line can run to hundreds of kilobytes,
  // and a tokenizer over that gains nothing a viewer can use.
  jsonl: { kind: "text", label: "JSON Lines", mime: "text/plain", icon: "text" },
  ndjson: { kind: "text", label: "JSON Lines", mime: "text/plain", icon: "text" },
  csv: { kind: "text", label: "CSV data", mime: "text/csv", icon: "sheet" },
  tsv: { kind: "text", label: "TSV data", mime: "text/tab-separated-values", icon: "sheet" },

  // ── Source ────────────────────────────────────────────────────────────────
  // HTML is shown as source: rendering an untrusted document buys nothing for a
  // preview and costs an audit.
  html: code("HTML source", "xml"),
  htm: code("HTML source", "xml"),
  xhtml: code("XHTML source", "xml"),
  xml: code("XML", "xml"),
  plist: code("Property list", "xml", "config"),
  svgz: opaque("Compressed SVG", "vector"),
  js: code("JavaScript", "js"),
  mjs: code("JavaScript module", "js"),
  cjs: code("CommonJS module", "js"),
  jsx: code("JavaScript (JSX)", "jsx"),
  ts: code("TypeScript", "ts"),
  tsx: code("TypeScript (JSX)", "jsx"),
  json: code("JSON", "json", "config"),
  jsonc: code("JSON with comments", "json", "config"),
  json5: code("JSON5", "json", "config"),
  yaml: code("YAML", "yaml", "config"),
  yml: code("YAML", "yaml", "config"),
  toml: code("TOML", "toml", "config"),
  ini: code("INI config", "toml", "config"),
  conf: code("Config file", "toml", "config"),
  cfg: code("Config file", "toml", "config"),
  env: code("Environment file", "shell", "config"),
  css: code("Stylesheet", "css"),
  scss: code("Sass stylesheet", "css"),
  sass: code("Sass stylesheet", "css"),
  less: code("Less stylesheet", "css"),
  py: code("Python", "python"),
  pyi: code("Python stubs", "python"),
  rb: code("Ruby", "c-like"),
  rs: code("Rust", "rust"),
  go: code("Go", "go"),
  c: code("C", "c-like"),
  h: code("C header", "c-like"),
  cc: code("C++", "c-like"),
  cpp: code("C++", "c-like"),
  cxx: code("C++", "c-like"),
  hpp: code("C++ header", "c-like"),
  m: code("Objective-C", "c-like"),
  mm: code("Objective-C++", "c-like"),
  swift: code("Swift", "c-like"),
  java: code("Java", "c-like"),
  kt: code("Kotlin", "c-like"),
  scala: code("Scala", "c-like"),
  php: code("PHP", "c-like"),
  pl: code("Perl", "c-like"),
  lua: code("Lua", "c-like"),
  r: code("R", "c-like"),
  dart: code("Dart", "c-like"),
  ex: code("Elixir", "c-like"),
  exs: code("Elixir script", "c-like"),
  erl: code("Erlang", "c-like"),
  hs: code("Haskell", "c-like"),
  zig: code("Zig", "c-like"),
  sql: code("SQL", "sql", "database"),
  graphql: code("GraphQL", "c-like"),
  gql: code("GraphQL", "c-like"),
  proto: code("Protocol buffers", "c-like"),
  diff: code("Diff", "plain"),
  patch: code("Patch", "plain"),

  // Shell scripts are source to read, but the daemon will refuse to launch
  // them and so must the menu.
  sh: { ...code("Shell script", "shell", "terminal"), executable: true },
  bash: { ...code("Bash script", "shell", "terminal"), executable: true },
  zsh: { ...code("Zsh script", "shell", "terminal"), executable: true },
  fish: { ...code("Fish script", "shell", "terminal"), executable: true },
  ps1: { ...code("PowerShell script", "shell", "terminal"), executable: true },
  bat: { ...code("Batch file", "shell", "terminal"), executable: true },
  cmd: { ...code("Batch file", "shell", "terminal"), executable: true },

  // ── Archives and binaries ─────────────────────────────────────────────────
  zip: opaque("Zip archive", "archive"),
  tar: opaque("Tar archive", "archive"),
  gz: opaque("Gzip archive", "archive"),
  bz2: opaque("Bzip2 archive", "archive"),
  xz: opaque("XZ archive", "archive"),
  zst: opaque("Zstd archive", "archive"),
  "7z": opaque("7-Zip archive", "archive"),
  rar: opaque("RAR archive", "archive"),
  dmg: ql("Disk image", "archive"),
  iso: opaque("Disk image", "archive"),
  pkg: opaque("Installer package", "archive", true),
  deb: opaque("Debian package", "archive"),
  rpm: opaque("RPM package", "archive"),
  exe: opaque("Windows executable", "binary", true),
  dll: opaque("Windows library", "binary", true),
  so: opaque("Shared library", "binary", true),
  dylib: opaque("Shared library", "binary", true),
  o: opaque("Object file", "binary"),
  a: opaque("Static library", "binary"),
  wasm: opaque("WebAssembly module", "binary"),
  class: opaque("Java class", "binary"),
  jar: opaque("Java archive", "archive", true),
  pyc: opaque("Python bytecode", "binary"),
  app: opaque("Application bundle", "binary", true),
  command: opaque("Shell command file", "terminal", true),
  workflow: opaque("Automator workflow", "binary", true),
  scpt: opaque("AppleScript", "binary", true),
  // URL indirection: tiny text files that hand a scheme to the OS. The daemon
  // refuses them explicitly; never offer to open one.
  webloc: opaque("Web location", "config", true),
  inetloc: opaque("Internet location", "config", true),
  fileloc: opaque("File location", "config", true),
  url: opaque("URL shortcut", "config", true),
  lnk: opaque("Windows shortcut", "config", true),

  // ── Keys and certificates ─────────────────────────────────────────────────
  pem: code("PEM certificate", "plain", "key"),
  crt: opaque("Certificate", "key"),
  cer: opaque("Certificate", "key"),
  pub: code("Public key", "plain", "key"),
  keychain: opaque("Keychain", "key"),

  // ── Fonts and data ────────────────────────────────────────────────────────
  ttf: ql("TrueType font", "font", "font/ttf"),
  otf: ql("OpenType font", "font", "font/otf"),
  woff: ql("Web font", "font", "font/woff"),
  woff2: ql("Web font", "font", "font/woff2"),
  db: opaque("Database", "database"),
  sqlite: opaque("SQLite database", "database"),
  sqlite3: opaque("SQLite database", "database"),
};

/**
 * The extension, lowercased and without its dot. A leading dot is part of the
 * name, not an extension: `.gitignore` has none.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function compoundOf(lower: string): Entry | undefined {
  for (const [suffix, entry] of COMPOUND) {
    if (lower.length > suffix.length && lower.endsWith(suffix)) return entry;
  }
  return undefined;
}

const UNKNOWN: Entry = {
  kind: "quicklook",
  label: "File",
  mime: "application/octet-stream",
  icon: "file",
};

/**
 * Extensionless names that are conventionally prose or config.
 *
 * Matched as a prefix, because these arrive with every kind of suffix in
 * practice — `LICENSE-MIT`, `README.old`, `CHANGELOG-2024`.
 */
const DOC_PREFIXES: Array<[string, string]> = [
  ["readme", "Readme"],
  ["license", "License"],
  ["licence", "Licence"],
  ["copying", "License"],
  ["notice", "Notice"],
  ["authors", "Authors"],
  ["contributors", "Contributors"],
  ["contributing", "Contributing guide"],
  ["changelog", "Changelog"],
  ["changes", "Changelog"],
  ["codeowners", "Code owners"],
  ["security", "Security policy"],
  ["todo", "To-do"],
  ["version", "Version"],
];

/**
 * A file with no extension at all is text far more often than not — licences,
 * readmes, dotfiles, scripts. Reading a kilobyte and letting the decoder reject
 * it is both faster and more likely to be right than asking the host to render
 * it, which costs a subprocess and can take seconds.
 */
function extensionlessEntry(lower: string): Entry {
  const matched = DOC_PREFIXES.find(([prefix]) => lower.startsWith(prefix));
  return {
    kind: "text",
    label: matched ? matched[1] : "Text file",
    mime: "text/plain",
    icon: "text",
  };
}

export function classifyFile(entry: {
  name: string;
  kind?: HostDirEntry["kind"];
  size?: number | null;
}): FileTypeInfo {
  // A symlink can never be previewed: the daemon walks every component with
  // no-follow semantics and rejects the leaf too, so there is nothing to read.
  // This is a designed state with its own copy, not an error.
  if (entry.kind === "symlink") {
    return finish({
      kind: "none",
      label: "Symbolic link",
      mime: "application/octet-stream",
      icon: "symlink",
    });
  }
  if (entry.kind === "directory") {
    return finish({ kind: "none", label: "Folder", mime: "", icon: "file" });
  }
  // Sockets, fifos, devices: opening one can block forever.
  if (entry.kind === "other") {
    return finish({
      kind: "none",
      label: "Special file",
      mime: "application/octet-stream",
      icon: "binary",
    });
  }

  const lower = entry.name.toLowerCase();
  const extension = extensionOf(entry.name);
  const found =
    WHOLE_NAME[lower] ??
    compoundOf(lower) ??
    (extension ? BY_EXTENSION[extension] : undefined) ??
    (extension ? UNKNOWN : extensionlessEntry(lower));
  return finish(found);
}

function finish(entry: Entry): FileTypeInfo {
  const autoBytes = entry.autoBytes ?? PREVIEW_BUDGET.autoFetch;
  return {
    kind: entry.kind,
    label: entry.label,
    mime: entry.mime,
    icon: entry.icon,
    ...(entry.language ? { language: entry.language } : {}),
    autoBytes,
    maxBytes: entry.maxBytes ?? PREVIEW_BUDGET.inlineMax,
    ...(entry.executable ? { executable: true } : {}),
  };
}

/** Kinds the browser renders itself from real bytes. */
export function isNativeKind(kind: PreviewKind): boolean {
  return kind !== "quicklook" && kind !== "none";
}

/** Kinds whose preview is a decoded string rather than an object URL. */
export function isTextKind(kind: PreviewKind): boolean {
  return kind === "text" || kind === "code" || kind === "markdown";
}
